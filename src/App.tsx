import { useState } from 'react';
import { FileUpload } from './components/FileUpload';
import { ResultsTable } from './components/ResultsTable';
import { supabase, AuditResult } from './lib/supabase';
import { parseRawAuditData, parseThresholdData } from './lib/csvParser';
import { AlertCircle, BarChart3, Loader2 } from 'lucide-react';

type ProcessingStage = 'idle' | 'uploading' | 'processing' | 'completed' | 'error';

function App() {
  const [rawDataFile, setRawDataFile] = useState<File | null>(null);
  const [thresholdFile, setThresholdFile] = useState<File | null>(null);
  const [auditPrompt, setAuditPrompt] = useState<string>(
    'Analyze the retail audit data and verify if buyLeads are correctly classified as retail or non-retail based on the quantity thresholds. Provide detailed reasoning for any misclassifications.'
  );
  const [stage, setStage] = useState<ProcessingStage>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [results, setResults] = useState<AuditResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');

  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  const processAudit = async () => {
    if (!rawDataFile || !thresholdFile) {
      setError('Please upload both files');
      return;
    }

    try {
      setStage('uploading');
      setError(null);
      setProgress('Reading files...');

      const rawDataText = await readFileAsText(rawDataFile);
      const thresholdText = await readFileAsText(thresholdFile);

      const rawData = parseRawAuditData(rawDataText);
      const thresholdData = parseThresholdData(thresholdText);

      if (rawData.length === 0) {
        throw new Error('No valid data found in raw audit file');
      }

      if (thresholdData.length === 0) {
        throw new Error('No valid data found in threshold file');
      }

      setProgress(`Creating audit session...`);

      const { data: session, error: sessionError } = await supabase
        .from('audit_sessions')
        .insert({
          session_name: `Audit - ${new Date().toLocaleString()}`,
          status: 'uploading',
          raw_data_count: rawData.length,
        })
        .select()
        .single();

      if (sessionError) throw sessionError;
      setSessionId(session.id);

      setProgress(`Uploading ${rawData.length} audit records...`);

      const rawDataInserts = rawData.map((row) => ({
        session_id: session.id,
        eto_ofr_display_id: row.eto_ofr_display_id,
        eto_ofr_approv_date_orig: row.eto_ofr_approv_date_orig || null,
        fk_glcat_mcat_id: row.fk_glcat_mcat_id,
        eto_ofr_glcat_mcat_name: row.eto_ofr_glcat_mcat_name,
        quantity: parseFloat(row.quantity) || 0,
        quantity_unit: row.quantity_unit,
        probable_order_value: row.probable_order_value,
        bl_segment: row.bl_segment,
        bl_details: row.bl_details,
      }));

      // Insert raw data and get the inserted records with their IDs
      const { data: insertedRawData, error: rawDataError } = await supabase
        .from('raw_audit_data')
        .insert(rawDataInserts)
        .select(); // Add .select() to return the inserted records

      if (rawDataError) throw rawDataError;

      setProgress(`Uploading ${thresholdData.length} threshold records...`);

      const thresholdInserts = thresholdData.map((row) => ({
        session_id: session.id,
        fk_glcat_mcat_id: row.fk_glcat_mcat_id,
        glcat_mcat_name: row.glcat_mcat_name,
        leap_retail_qty_cutoff: parseFloat(row.leap_retail_qty_cutoff) || 0,
        gl_unit_name: row.gl_unit_name,
      }));

      const { error: thresholdError } = await supabase
        .from('threshold_data')
        .insert(thresholdInserts);

      if (thresholdError) throw thresholdError;

      setStage('processing');
      setProgress('Processing audit with ChatGPT...');

      const edgeFunctionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/audit-with-chatgpt`;

      const auditResponse = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          sessionId: session.id,
          auditPrompt: auditPrompt,
          rawData: insertedRawData,
          thresholdData: thresholdInserts,
        }),
      });

      if (!auditResponse.ok) {
        const errorData = await auditResponse.json();
        throw new Error(errorData.error || 'Failed to process audit with AI');
      }

      const { results: auditResultsData } = await auditResponse.json();

      setProgress('Saving audit results...');

      const batchSize = 100;
      for (let i = 0; i < auditResultsData.length; i += batchSize) {
        const batch = auditResultsData.slice(i, i + batchSize);
        const { error: insertError } = await supabase
          .from('audit_results')
          .insert(batch);

        if (insertError) throw insertError;
      }

      setProgress('Loading results...');

      const { data: auditResults, error: resultsError } = await supabase
        .from('audit_results')
        .select('*')
        .eq('session_id', session.id);

      if (resultsError) throw resultsError;

      setResults(auditResults || []);

      await supabase
        .from('audit_sessions')
        .update({
          status: 'completed',
          results_count: auditResults?.length || 0,
          completed_at: new Date().toISOString(),
        })
        .eq('id', session.id);

      setStage('completed');
      setProgress('');
    } catch (err: any) {
      setStage('error');
      setError(err.message || 'An error occurred during processing');
      console.error('Processing error:', err);

      if (sessionId) {
        await supabase
          .from('audit_sessions')
          .update({
            status: 'failed',
            error_message: err.message,
          })
          .eq('id', sessionId);
      }
    }
  };

  const resetApp = () => {
    setRawDataFile(null);
    setThresholdFile(null);
    setAuditPrompt(
      'Analyze the retail audit data and verify if buyLeads are correctly classified as retail or non-retail based on the quantity thresholds. Provide detailed reasoning for any misclassifications.'
    );
    setStage('idle');
    setSessionId(null);
    setResults([]);
    setError(null);
    setProgress('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <header className="mb-8">
          <div className="flex items-center mb-3">
            <BarChart3 className="h-10 w-10 text-teal-600 mr-3" />
            <h1 className="text-4xl font-bold text-gray-900">Data Audit System</h1>
          </div>
          <p className="text-gray-600 text-lg">
            AI-powered retail audit data validation and analysis
          </p>
        </header>

        {stage !== 'completed' ? (
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-2xl font-semibold text-gray-900 mb-6">
              Upload Audit Files
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <FileUpload
                label="Raw Audit Data"
                accept=".csv"
                onFileSelect={setRawDataFile}
                selectedFile={rawDataFile}
              />

              <FileUpload
                label="Threshold Reference Sheet"
                accept=".csv"
                onFileSelect={setThresholdFile}
                selectedFile={thresholdFile}
              />
            </div>

            <div className="mb-8">
              <label htmlFor="auditPrompt" className="block text-sm font-medium text-gray-700 mb-2">
                AI Audit Prompt
              </label>
              <textarea
                id="auditPrompt"
                value={auditPrompt}
                onChange={(e) => setAuditPrompt(e.target.value)}
                rows={4}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-teal-500 focus:ring-2 focus:ring-teal-200 transition-colors resize-none text-sm text-gray-900"
                placeholder="Enter instructions for the AI audit process..."
              />
              <p className="mt-2 text-xs text-gray-500">
                Customize the AI prompt to guide the audit analysis and classification logic
              </p>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start">
                <AlertCircle className="h-5 w-5 text-red-600 mr-3 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-red-900 mb-1">Error</h3>
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              </div>
            )}

            {progress && (
              <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg flex items-center">
                <Loader2 className="h-5 w-5 text-blue-600 mr-3 animate-spin" />
                <p className="text-sm text-blue-900 font-medium">{progress}</p>
              </div>
            )}

            <button
              onClick={processAudit}
              disabled={!rawDataFile || !thresholdFile || stage !== 'idle'}
              className={`
                w-full py-3 px-6 rounded-lg font-semibold text-white text-lg
                transition-all duration-200 shadow-md
                ${
                  !rawDataFile || !thresholdFile || stage !== 'idle'
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-teal-600 hover:bg-teal-700 hover:shadow-lg'
                }
              `}
            >
              {stage === 'idle' && 'Start Audit Process'}
              {stage === 'uploading' && 'Uploading Files...'}
              {stage === 'processing' && 'Processing Audit...'}
            </button>

            <div className="mt-6 p-4 bg-gray-50 rounded-lg">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">
                Required File Format
              </h3>
              <div className="text-xs text-gray-600 space-y-1">
                <p><strong>Raw Audit Data:</strong> eto_ofr_display_id, eto_ofr_approv_date_orig, fk_glcat_mcat_id, eto_ofr_glcat_mcat_name, quantity, quantity_unit, probable_order_value, bl_segment, bl_details</p>
                <p><strong>Threshold Data:</strong> fk_glcat_mcat_id, glcat_mcat_name, leap_retail_qty_cutoff, gl_unit_name</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-lg p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold text-gray-900 mb-2">
                    Audit Complete
                  </h2>
                  <p className="text-gray-600">
                    Successfully processed {results.length} records
                  </p>
                </div>
                <button
                  onClick={resetApp}
                  className="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold"
                >
                  New Audit
                </button>
              </div>
            </div>

            <ResultsTable
              results={results}
              sessionName={`audit_${new Date().toISOString().split('T')[0]}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;