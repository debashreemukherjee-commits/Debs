import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Pre-compile regex for better performance
const JSON_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/;

interface AuditRequest {
  sessionId: string;
  auditPrompt: string;
  rawData: Array<{
    id: string;
    eto_ofr_display_id: string;
    fk_glcat_mcat_id: string;
    eto_ofr_glcat_mcat_name: string;
    quantity: number;
    quantity_unit: string;
    probable_order_value: string;
    bl_segment: string;
    bl_details: string;
    business_mcat_key?: number;
  }>;
  thresholdData: Array<{
    fk_glcat_mcat_id: string;
    glcat_mcat_name: string;
    leap_retail_qty_cutoff: number;
    gl_unit_name: string;
  }>;
}

interface AuditResult {
  session_id: string;
  raw_data_id: string;
  eto_ofr_display_id: string;
  fk_glcat_mcat_id: string;
  category_name: string;
  quantity: number;
  quantity_unit: string;
  bl_segment: string;
  business_mcat_key: number | null;
  mcat_type: string;
  indiamart_audit_outcome: string;
  threshold_available: boolean;
  threshold_value: string;
  indiamart_category: string;
  indiamart_reason: string;
  llm_bl_type: string;
  llm_threshold_value: string;
  llm_threshold_reason: string;
}

// Cache for unit normalization results
const unitNormalizationCache = new Map<string, string>();

const normalizeUnit = (unit: string): string => {
  if (!unit) return "";
  
  // Check cache first
  const cached = unitNormalizationCache.get(unit);
  if (cached !== undefined) return cached;
  
  const normalized = unit.toLowerCase().trim();
  unitNormalizationCache.set(unit, normalized);
  return normalized;
};

// Pre-compute retail segments set for faster lookups
const RETAIL_SEGMENTS = new Set(["retail - indian", "retail - foreign"]);

// Optimized batch processing with concurrency control
async function processBatch(
  batch: AuditRequest["rawData"],
  sessionId: string,
  auditPrompt: string,
  thresholdMap: Map<string, AuditRequest["thresholdData"][0]>,
  llmGatewayKey: string,
  concurrencyLimit: number = 5
): Promise<AuditResult[]> {
  const results: AuditResult[] = new Array(batch.length);
  let activePromises = 0;
  let currentIndex = 0;
  
  return new Promise((resolve) => {
    function startNext() {
      while (activePromises < concurrencyLimit && currentIndex < batch.length) {
        const index = currentIndex++;
        activePromises++;
        
        processRecord(batch[index], sessionId, auditPrompt, thresholdMap, llmGatewayKey)
          .then(result => {
            results[index] = result;
          })
          .catch(error => {
            console.error(`Error processing record at index ${index}:`, error);
            results[index] = createErrorResult(batch[index], sessionId, error);
          })
          .finally(() => {
            activePromises--;
            startNext();
          });
      }
      
      if (activePromises === 0 && currentIndex === batch.length) {
        resolve(results);
      }
    }
    
    startNext();
  });
}

// Optimized record processing function
async function processRecord(
  record: AuditRequest["rawData"][0],
  sessionId: string,
  auditPrompt: string,
  thresholdMap: Map<string, AuditRequest["thresholdData"][0]>,
  llmGatewayKey: string
): Promise<AuditResult> {
  const businessMcatKey = record.business_mcat_key || 0;
  const thresholdKey = `${record.fk_glcat_mcat_id}_${normalizeUnit(record.quantity_unit)}`;
  const threshold = thresholdMap.get(thresholdKey);
  const thresholdAvailable = !!threshold;
  
  // Pre-compute segment check once
  const segment = record.bl_segment?.toLowerCase() || "";
  const markedAsRetail = RETAIL_SEGMENTS.has(segment);
  
  // Calculate Indiamart audit result
  const auditResult = calculateIndiamartAudit(
    record,
    businessMcatKey,
    threshold,
    thresholdAvailable,
    markedAsRetail
  );
  
  // Get LLM assessment
  const llmResult = await getLLMAssessment(
    record,
    auditPrompt,
    llmGatewayKey
  );
  
  return {
    session_id: sessionId,
    raw_data_id: record.id,
    eto_ofr_display_id: record.eto_ofr_display_id,
    fk_glcat_mcat_id: record.fk_glcat_mcat_id,
    category_name: record.eto_ofr_glcat_mcat_name,
    quantity: record.quantity,
    quantity_unit: record.quantity_unit,
    bl_segment: record.bl_segment,
    business_mcat_key: businessMcatKey,
    ...auditResult,
    ...llmResult
  };
}

// Separate function for Indiamart audit calculation
function calculateIndiamartAudit(
  record: AuditRequest["rawData"][0],
  businessMcatKey: number,
  threshold: AuditRequest["thresholdData"][0] | undefined,
  thresholdAvailable: boolean,
  markedAsRetail: boolean
) {
  let mcatType = "Standard MCAT";
  let indiamartOutcome = "PASS";
  let indiamartCategory = "";
  let indiamartReason = "";
  let thresholdValue = "NA";

  if (thresholdAvailable && threshold) {
    thresholdValue = `${threshold.leap_retail_qty_cutoff} ${threshold.gl_unit_name}`;
  }

  if (businessMcatKey === 1) {
    mcatType = "Business MCAT";
    
    if (markedAsRetail) {
      indiamartOutcome = "ERROR";
      indiamartCategory = "Retail Wrongly Marked";
      indiamartReason = "Business MCAT Key = 1 requires Non-Retail classification, but system marked as Retail";
    } else {
      indiamartOutcome = "PASS";
      indiamartCategory = "Non-Retail Correctly Marked";
      indiamartReason = "";
    }
  } else if (!thresholdAvailable) {
    indiamartOutcome = "ERROR";
    indiamartCategory = "Threshold Not Available";
    indiamartReason = "MCAT threshold not found in attached sheet - cannot perform threshold-based audit";
    thresholdValue = "NA";
  } else {
    const quantity = record.quantity;
    const cutoff = threshold!.leap_retail_qty_cutoff;
    const shouldBeRetail = quantity <= cutoff;

    if (shouldBeRetail && markedAsRetail) {
      indiamartCategory = "Retail Correctly Marked";
      indiamartOutcome = "PASS";
      indiamartReason = "";
    } else if (!shouldBeRetail && !markedAsRetail) {
      indiamartCategory = "Non-Retail Correctly Marked";
      indiamartOutcome = "PASS";
      indiamartReason = "";
    } else if (shouldBeRetail && !markedAsRetail) {
      indiamartCategory = "Non-Retail Wrongly Marked";
      indiamartOutcome = "ERROR";
      indiamartReason = `Quantity ${quantity} ${record.quantity_unit} is within threshold ${cutoff} ${threshold!.gl_unit_name} but system marked as Non-Retail`;
    } else {
      indiamartCategory = "Retail Wrongly Marked";
      indiamartOutcome = "ERROR";
      indiamartReason = `Quantity ${quantity} ${record.quantity_unit} exceeds threshold ${cutoff} ${threshold!.gl_unit_name} but system marked as Retail`;
    }
  }

  return {
    mcat_type: mcatType,
    indiamart_audit_outcome: indiamartOutcome,
    threshold_available: thresholdAvailable,
    threshold_value: thresholdValue,
    indiamart_category: indiamartCategory,
    indiamart_reason: indiamartReason
  };
}

// Optimized LLM assessment function with retry logic
async function getLLMAssessment(
  record: AuditRequest["rawData"][0],
  auditPrompt: string,
  llmGatewayKey: string,
  retries: number = 2
): Promise<{ llm_bl_type: string; llm_threshold_value: string; llm_threshold_reason: string }> {
  const systemPrompt = `${auditPrompt}

You are evaluating using LLM Logic ONLY. This is independent of system classification and sheet thresholds.

Rules for LLM Logic:
- Ignore system classification completely
- Do NOT use MCAT thresholds from the provided sheet
- Base your evaluation purely on human commercial logic and typical buying behavior
- Consider market norms and practical usage patterns
- This is an opinionated, advisory assessment

Respond ONLY with a valid JSON object in this exact format:
{
  "bl_type": "Retail" or "Non-Retail",
  "threshold_value": "suggested threshold with unit as string",
  "reasoning": "1-2 sentences explaining typical consumer vs commercial buying behaviour for this product category"
}`;

  const userPrompt = `Evaluate this Buyer Lead using independent LLM commercial logic:

Record Details:
- Buylead ID: ${record.eto_ofr_display_id}
- Category: ${record.eto_ofr_glcat_mcat_name}
- Quantity Requested: ${record.quantity} ${record.quantity_unit}
- Probable Order Value: ${record.probable_order_value}
- Buyer Details: ${record.bl_details}

DO NOT reference the sheet threshold. Provide your independent commercial assessment.`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch("https://imllm.intermesh.net/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${llmGatewayKey}`,
          "Connection": "keep-alive" // Reuse connection
        },
        body: JSON.stringify({
          model: "qwen/qwen3-32b",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }
      
      const data = await response.json();
      const content = data.choices[0].message.content;
      
      // Optimized JSON parsing
      const jsonMatch = content.match(JSON_BLOCK_REGEX) || [null, content];
      const jsonString = jsonMatch[1].trim();
      const llmResponse = JSON.parse(jsonString);

      return {
        llm_bl_type: llmResponse.bl_type || "Unknown",
        llm_threshold_value: llmResponse.threshold_value || "Not specified",
        llm_threshold_reason: llmResponse.reasoning || "No reasoning provided",
      };
    } catch (error) {
      if (attempt === retries) {
        console.error(`LLM error for ${record.eto_ofr_display_id} after ${retries} retries:`, error);
        return {
          llm_bl_type: "Error",
          llm_threshold_value: "Error",
          llm_threshold_reason: `Error processing with AI after ${retries + 1} attempts: ${error.message}`,
        };
      }
      // Exponential backoff before retry
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
    }
  }
  
  // This should never be reached due to the retry loop, but TypeScript needs it
  return createErrorResult(record, "", new Error("Unexpected error in LLM assessment")).llmResult;
}

// Helper function to create error result
function createErrorResult(
  record: AuditRequest["rawData"][0],
  sessionId: string,
  error: Error
): AuditResult & { llmResult: any } {
  const baseResult = {
    session_id: sessionId,
    raw_data_id: record.id,
    eto_ofr_display_id: record.eto_ofr_display_id,
    fk_glcat_mcat_id: record.fk_glcat_mcat_id,
    category_name: record.eto_ofr_glcat_mcat_name,
    quantity: record.quantity,
    quantity_unit: record.quantity_unit,
    bl_segment: record.bl_segment,
    business_mcat_key: record.business_mcat_key || 0,
    mcat_type: "Standard MCAT",
    indiamart_audit_outcome: "PASS",
    threshold_available: false,
    threshold_value: "NA",
    indiamart_category: "",
    indiamart_reason: "",
  };
  
  return {
    ...baseResult,
    llm_bl_type: "Error",
    llm_threshold_value: "Error",
    llm_threshold_reason: `Error processing with AI: ${error.message}`,
    llmResult: {}
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const llmGatewayKey = Deno.env.get("LLM_GATEWAY_KEY");
    if (!llmGatewayKey) {
      throw new Error("LLM_GATEWAY_KEY is not configured");
    }

    const { sessionId, auditPrompt, rawData, thresholdData }: AuditRequest = await req.json();

    if (!sessionId || !auditPrompt || !rawData || !thresholdData) {
      throw new Error("Missing required fields");
    }

    // Clear normalization cache periodically to prevent memory issues
    if (unitNormalizationCache.size > 10000) {
      unitNormalizationCache.clear();
    }

    // Optimized threshold map creation
    const thresholdMap = new Map(
      thresholdData.map(t => [
        `${t.fk_glcat_mcat_id}_${normalizeUnit(t.gl_unit_name)}`,
        t
      ])
    );

    const auditResults: AuditResult[] = [];
    
    // Dynamic batch sizing based on data size
    const batchSize = rawData.length > 1000 ? 50 : 20;
    const concurrencyLimit = rawData.length > 500 ? 10 : 5;
    
    for (let i = 0; i < rawData.length; i += batchSize) {
      const batch = rawData.slice(i, i + batchSize);
      
      const batchResults = await processBatch(
        batch,
        sessionId,
        auditPrompt,
        thresholdMap,
        llmGatewayKey,
        concurrencyLimit
      );
      
      auditResults.push(...batchResults);
      
      // Allow event loop to breathe between batches
      if (i + batchSize < rawData.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return new Response(
      JSON.stringify({ success: true, results: auditResults }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "An error occurred during audit processing"
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});