import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Debug: Check if API key exists (but don't log the full key)
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) {
      console.error("OPENAI_API_KEY environment variable is not set");
      throw new Error("OPENAI_API_KEY is not configured. Please set it in your Supabase Edge Function secrets.");
    }
    
    // Log key length and first few chars to verify it's loaded (safe for debugging)
    console.log(`OpenAI API Key loaded: length=${openaiApiKey.length}, starts with=${openaiApiKey.substring(0, 7)}...`);

    const { sessionId, auditPrompt, rawData, thresholdData }: AuditRequest = await req.json();

    if (!sessionId || !auditPrompt || !rawData || !thresholdData) {
      throw new Error("Missing required fields");
    }

    const normalizeUnit = (unit: string): string => {
      if (!unit) return "";
      return unit.toLowerCase().trim();
    };

    const thresholdMap = new Map(
      thresholdData.map((t) => {
        const key = `${t.fk_glcat_mcat_id}_${normalizeUnit(t.gl_unit_name)}`;
        return [key, t];
      })
    );

    const auditResults: AuditResult[] = [];

    const batchSize = 20;
    for (let i = 0; i < rawData.length; i += batchSize) {
      const batch = rawData.slice(i, i + batchSize);

      const batchPromises = batch.map(async (record) => {
        const businessMcatKey = record.business_mcat_key || 0;
        const thresholdKey = `${record.fk_glcat_mcat_id}_${normalizeUnit(record.quantity_unit)}`;
        const threshold = thresholdMap.get(thresholdKey);
        const thresholdAvailable = !!threshold;
        const segment = record.bl_segment;
        const markedAsRetail = segment?.toLowerCase() === "retail - indian" || 
                       segment?.toLowerCase() === "retail - foreign";

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
          const cutoff = threshold.leap_retail_qty_cutoff;
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
            indiamartReason = `Quantity ${quantity} ${record.quantity_unit} is within threshold ${cutoff} ${threshold.gl_unit_name} but system marked as Non-Retail`;
          } else {
            indiamartCategory = "Retail Wrongly Marked";
            indiamartOutcome = "ERROR";
            indiamartReason = `Quantity ${quantity} ${record.quantity_unit} exceeds threshold ${cutoff} ${threshold.gl_unit_name} but system marked as Retail`;
          }
        }

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

        try {
          console.log(`Calling OpenAI API for record ${record.eto_ofr_display_id}`);
          
          const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${openaiApiKey}`,
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              temperature: 0,
              max_tokens: 600,
              response_format: { type: "json_object" },
            }),
          });

          // Enhanced error handling for OpenAI API
          if (!response.ok) {
            const errorText = await response.text();
            console.error(`OpenAI API Error for record ${record.eto_ofr_display_id}:`);
            console.error("Status:", response.status);
            console.error("Status Text:", response.statusText);
            console.error("Response Body:", errorText);
            
            // Try to parse the error for more details
            try {
              const errorJson = JSON.parse(errorText);
              console.error("OpenAI Error Code:", errorJson.error?.code);
              console.error("OpenAI Error Message:", errorJson.error?.message);
              console.error("OpenAI Error Type:", errorJson.error?.type);
              
              // Special handling for 401 errors
              if (response.status === 401) {
                throw new Error(`OpenAI API authentication failed. Please check if your OPENAI_API_KEY is valid. Details: ${errorJson.error?.message || 'Invalid API key'}`);
              }
            } catch (parseError) {
              // If it's not JSON, just log the raw text
              console.error("Raw error response:", errorText);
            }
            
            throw new Error(`OpenAI API error: ${response.status} - ${errorText.substring(0, 200)}`);
          }

          const data = await response.json();
          const content = data.choices[0].message.content;
          console.log(`OpenAI API success for record ${record.eto_ofr_display_id}:`, content.substring(0, 100) + "...");
          
          const llmResponse = JSON.parse(content);

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
            mcat_type: mcatType,
            indiamart_audit_outcome: indiamartOutcome,
            threshold_available: thresholdAvailable,
            threshold_value: thresholdValue,
            indiamart_category: indiamartCategory,
            indiamart_reason: indiamartReason,
            llm_bl_type: llmResponse.bl_type || "Unknown",
            llm_threshold_value: llmResponse.threshold_value || "Not specified",
            llm_threshold_reason: llmResponse.reasoning || "No reasoning provided",
          };
        } catch (error) {
          console.error(`Error processing record ${record.eto_ofr_display_id}:`, error);

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
            mcat_type: mcatType,
            indiamart_audit_outcome: indiamartOutcome,
            threshold_available: thresholdAvailable,
            threshold_value: thresholdValue,
            indiamart_category: indiamartCategory,
            indiamart_reason: indiamartReason,
            llm_bl_type: "Error",
            llm_threshold_value: "Error",
            llm_threshold_reason: `Error processing with AI: ${error.message}`,
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      auditResults.push(...batchResults);
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