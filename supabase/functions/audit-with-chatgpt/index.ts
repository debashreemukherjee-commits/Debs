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
  evaluation_rationale: string;
}

interface EvaluationSignals {
  thresholdSignal: {
    available: boolean;
    verdict: string;
    reason: string;
  };
  povSignal: {
    value: string;
    assessment: string;
  };
  buyerIntentSignal: {
    extractedUse: string;
    assessment: string;
  };
  productTypeSignal: {
    category: string;
    details: string;
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
    // OpenAI API configuration
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) {
      console.error("OPENAI_API_KEY environment variable is not set");
      throw new Error("OPENAI_API_KEY is not configured. Please set it in your Supabase Edge Function secrets.");
    }

    const openaiBaseUrl = "https://api.openai.com/v1";
    const openaiModel = "gpt-4o-mini";

    console.log(`OpenAI configured: URL=${openaiBaseUrl}, Model=${openaiModel}`);

    const { sessionId, auditPrompt, rawData, thresholdData }: AuditRequest = await req.json();

    if (!sessionId || !auditPrompt || !rawData || !thresholdData) {
      throw new Error("Missing required fields");
    }

    const normalizeUnit = (unit: string): string => {
      if (!unit) return "";
      return unit.toLowerCase().trim();
    };

    const getUnitCategory = (unit: string): string | null => {
      const normalized = normalizeUnit(unit);
      const weightUnits = ["mg", "g", "kg", "tonne", "lbs", "lb", "oz", "ounce"];
      const volumeUnits = ["ml", "l", "liter", "litre", "gallon", "pint", "cc"];
      const lengthUnits = ["mm", "cm", "m", "km", "inch", "foot", "yard", "mile"];
      const countUnits = ["piece", "pieces", "unit", "units", "dozen", "count"];

      if (weightUnits.includes(normalized)) return "weight";
      if (volumeUnits.includes(normalized)) return "volume";
      if (lengthUnits.includes(normalized)) return "length";
      if (countUnits.includes(normalized)) return "count";
      return null;
    };

    const convertUnit = (value: number, fromUnit: string, toUnit: string): number => {
      const from = normalizeUnit(fromUnit);
      const to = normalizeUnit(toUnit);

      if (from === to) return value;

      const fromCategory = getUnitCategory(from);
      const toCategory = getUnitCategory(to);

      if (!fromCategory || !toCategory || fromCategory !== toCategory) {
        return value;
      }

      const weightConversions: { [key: string]: number } = {
        "mg": 0.001,
        "g": 1,
        "kg": 1000,
        "tonne": 1000000,
        "lbs": 453.592,
        "lb": 453.592,
        "oz": 28.3495,
        "ounce": 28.3495,
      };

      const volumeConversions: { [key: string]: number } = {
        "ml": 1,
        "l": 1000,
        "liter": 1000,
        "litre": 1000,
        "cc": 1,
        "gallon": 3785.41,
        "pint": 473.176,
      };

      const lengthConversions: { [key: string]: number } = {
        "mm": 1,
        "cm": 10,
        "m": 1000,
        "km": 1000000,
        "inch": 25.4,
        "foot": 304.8,
        "yard": 914.4,
        "mile": 1609344,
      };

      const countConversions: { [key: string]: number } = {
        "piece": 1,
        "pieces": 1,
        "unit": 1,
        "units": 1,
        "dozen": 12,
        "count": 1,
      };

      let conversions: { [key: string]: number } = {};
      if (fromCategory === "weight") conversions = weightConversions;
      else if (fromCategory === "volume") conversions = volumeConversions;
      else if (fromCategory === "length") conversions = lengthConversions;
      else if (fromCategory === "count") conversions = countConversions;

      const fromFactor = conversions[from] || 1;
      const toFactor = conversions[to] || 1;

      return (value * fromFactor) / toFactor;
    };

    const thresholdsByMcat = new Map<string, Array<{ threshold: any; unit: string }>>();
    thresholdData.forEach((t) => {
      const mcatId = t.fk_glcat_mcat_id;
      if (!thresholdsByMcat.has(mcatId)) {
        thresholdsByMcat.set(mcatId, []);
      }
      thresholdsByMcat.get(mcatId)!.push({ threshold: t, unit: normalizeUnit(t.gl_unit_name) });
    });

    const findThreshold = (mcatId: string, auditUnit: string) => {
      const thresholds = thresholdsByMcat.get(mcatId);
      if (!thresholds || thresholds.length === 0) return null;

      const normalizedAuditUnit = normalizeUnit(auditUnit);
      const auditUnitCategory = getUnitCategory(auditUnit);

      for (const { threshold, unit } of thresholds) {
        if (unit === normalizedAuditUnit) {
          return threshold;
        }
      }

      if (auditUnitCategory) {
        for (const { threshold, unit } of thresholds) {
          if (getUnitCategory(unit) === auditUnitCategory) {
            return threshold;
          }
        }
      }

      return thresholds[0].threshold;
    };

    const auditResults: AuditResult[] = [];

    const batchSize = 20;
    for (let i = 0; i < rawData.length; i += batchSize) {
      const batch = rawData.slice(i, i + batchSize);

      const batchPromises = batch.map(async (record) => {
        const businessMcatKey = record.business_mcat_key || 0;
        const threshold = findThreshold(record.fk_glcat_mcat_id, record.quantity_unit);
        const thresholdAvailable = !!threshold;
        const segment = record.bl_segment;
        const markedAsRetail = segment?.toLowerCase() === "retail - indian" ||
                       segment?.toLowerCase() === "retail - foreign";

        // Declare variables at the top of the function scope
        let mcatType = "Standard MCAT";
        let indiamartOutcome = "PASS";
        let indiamartCategory = "";
        let indiamartReason = "";
        let thresholdValue = "NA";
        let cutoff = 0; // Initialize cutoff
        let convertedQuantity = 0; // Initialize convertedQuantity

        if (thresholdAvailable && threshold) {
          thresholdValue = `${threshold.leap_retail_qty_cutoff} ${threshold.gl_unit_name}`;
          cutoff = threshold.leap_retail_qty_cutoff; // Store cutoff value
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
          convertedQuantity = convertUnit(quantity, record.quantity_unit, threshold.gl_unit_name);
          const shouldBeRetail = convertedQuantity <= cutoff;

          if (shouldBeRetail && markedAsRetail) {
            indiamartCategory = "Retail Correctly Marked";
            indiamartOutcome = "PASS";
            indiamartReason = `Threshold-based evaluation: Quantity ${quantity} ${record.quantity_unit} (${convertedQuantity.toFixed(2)} ${threshold.gl_unit_name}) <= threshold ${cutoff} ${threshold.gl_unit_name}`;
          } else if (!shouldBeRetail && !markedAsRetail) {
            indiamartCategory = "Non-Retail Correctly Marked";
            indiamartOutcome = "PASS";
            indiamartReason = `Threshold-based evaluation: Quantity ${quantity} ${record.quantity_unit} (${convertedQuantity.toFixed(2)} ${threshold.gl_unit_name}) > threshold ${cutoff} ${threshold.gl_unit_name}`;
          } else if (shouldBeRetail && !markedAsRetail) {
            indiamartCategory = "Non-Retail Wrongly Marked";
            indiamartOutcome = "ERROR";
            indiamartReason = `THRESHOLD VIOLATION: Quantity ${quantity} ${record.quantity_unit} (${convertedQuantity.toFixed(2)} ${threshold.gl_unit_name}) is within threshold ${cutoff} ${threshold.gl_unit_name} but system marked as Non-Retail`;
          } else {
            indiamartCategory = "Retail Wrongly Marked";
            indiamartOutcome = "ERROR";
            indiamartReason = `THRESHOLD VIOLATION: Quantity ${quantity} ${record.quantity_unit} (${convertedQuantity.toFixed(2)} ${threshold.gl_unit_name}) exceeds threshold ${cutoff} ${threshold.gl_unit_name} but system marked as Retail`;
          }
        }

        const systemPrompt = `${auditPrompt}

You are providing a commercial assessment to SUPPORT the audit process. Your analysis is advisory and must NOT override threshold-based evaluation.

CRITICAL CONFLICT RESOLUTION RULE:
1. MCAT threshold is PRIMARY and BINDING
2. Buyer intent is SUPPORTING signal only
3. If intent conflicts with threshold → ALWAYS follow the threshold
4. Business/office use alone does NOT imply Non-Retail unless threshold is breached

Evaluation Priority (for your reasoning):
1. Buyer Required Quantity vs MCAT Threshold (if available) - BINDING
2. Probable Order Value (POV) - Supporting signal
3. Buyer Intent / Usage Purpose - Supporting signal (Lowest Priority)
4. Product Type & Supporting Communication - Context only

Respond ONLY with a valid JSON object in this exact format:
{
  "bl_type": "Retail" or "Non-Retail",
  "threshold_value": "suggested threshold with unit as string",
  "reasoning": "1-2 sentences explaining typical consumer vs commercial buying behaviour for this product category",
  "evaluation_signals": {
    "threshold_signal": "Assessment of quantity vs typical thresholds",
    "pov_signal": "Assessment of probable order value implications",
    "buyer_intent_signal": "Extracted use case and implications",
    "product_type_assessment": "Category-specific retail vs non-retail indicators"
  },
  "conflict_notes": "Any conflicts between signals and how they should be resolved per the binding threshold rule"
}`;

        const userPrompt = `Evaluate this Buyer Lead using commercial logic. Remember: Threshold-based quantity evaluation is PRIMARY and BINDING.

Record Details:
- Buylead ID: ${record.eto_ofr_display_id}
- Category: ${record.eto_ofr_glcat_mcat_name}
- Quantity Requested: ${record.quantity} ${record.quantity_unit}
- Probable Order Value: ${record.probable_order_value}
- Buyer Details: ${record.bl_details}
- Current System Classification: ${markedAsRetail ? "Retail" : "Non-Retail"}
- Threshold Available: ${thresholdAvailable}
${thresholdAvailable ? `- MCAT Threshold: ${cutoff} ${threshold?.gl_unit_name}` : ""}

Provide your independent commercial assessment. Note: Your assessment is ADVISORY. If it conflicts with the threshold-based evaluation, the threshold-based evaluation takes precedence.`;

        try {
          console.log(`Calling OpenAI API for record ${record.eto_ofr_display_id}`);

          const response = await fetch(`${openaiBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${openaiApiKey}`,
            },
            body: JSON.stringify({
              model: openaiModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              temperature: 0,
              max_tokens: 600,
              response_format: { type: "json_object" },
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`OpenAI API Error for record ${record.eto_ofr_display_id}:`);
            console.error("Status:", response.status);
            console.error("Status Text:", response.statusText);
            console.error("Response Body:", errorText);

            try {
              const errorJson = JSON.parse(errorText);
              console.error("OpenAI Error Code:", errorJson.error?.code);
              console.error("OpenAI Error Message:", errorJson.error?.message);

              if (response.status === 401) {
                throw new Error(`OpenAI authentication failed. Please check your OPENAI_API_KEY. Details: ${errorJson.error?.message || 'Invalid API key'}`);
              }
            } catch (parseError) {
              console.error("Raw error response:", errorText);
            }

            throw new Error(`OpenAI API error: ${response.status} - ${errorText.substring(0, 200)}`);
          }

          const data = await response.json();
          const content = data.choices[0].message.content;
          console.log(`OpenAI success for record ${record.eto_ofr_display_id}:`, content.substring(0, 100) + "...");

          const llmResponse = JSON.parse(content);

          const buildEvaluationRationale = (): string => {
            const parts: string[] = [];

            parts.push(`EVALUATION SUMMARY FOR ${record.eto_ofr_display_id}:`);
            parts.push("");

            if (businessMcatKey === 1) {
              parts.push("PRIMARY SIGNAL: Business MCAT Key = 1");
              parts.push(`Status: ${indiamartOutcome === "PASS" ? "COMPLIANT" : "VIOLATION"}`);
              parts.push(`Reason: ${indiamartReason}`);
            } else if (!thresholdAvailable) {
              parts.push("PRIMARY SIGNAL: Threshold Not Available");
              parts.push(`Status: ${indiamartOutcome}`);
              parts.push(`Reason: ${indiamartReason}`);
            } else {
              parts.push("EVALUATION PRIORITY HIERARCHY:");
              parts.push(`1. BINDING THRESHOLD SIGNAL: ${indiamartCategory}`);
              parts.push(`   - Quantity: ${record.quantity} ${record.quantity_unit} (converted: ${convertedQuantity.toFixed(2)} ${threshold?.gl_unit_name})`);
              parts.push(`   - Threshold: ${cutoff} ${threshold?.gl_unit_name}`);
              parts.push(`   - Status: ${indiamartOutcome === "PASS" ? "COMPLIANT" : "VIOLATION"}`);
              parts.push("");

              parts.push("2. SUPPORTING SIGNALS (Advisory Only):");
              if (llmResponse.evaluation_signals) {
                const signals = llmResponse.evaluation_signals;
                if (signals.pov_signal) {
                  parts.push(`   - POV Assessment: ${signals.pov_signal}`);
                }
                if (signals.buyer_intent_signal) {
                  parts.push(`   - Buyer Intent: ${signals.buyer_intent_signal}`);
                }
                if (signals.product_type_assessment) {
                  parts.push(`   - Product Type: ${signals.product_type_assessment}`);
                }
              }

              parts.push("");
              parts.push("CONFLICT RESOLUTION:");
              if (llmResponse.conflict_notes) {
                parts.push(`LLM Assessment Notes: ${llmResponse.conflict_notes}`);
              }
              parts.push(`Threshold-based verdict takes PRECEDENCE. Final outcome: ${indiamartOutcome === "PASS" ? "COMPLIANT" : "VIOLATION"}`);
            }

            parts.push("");
            parts.push(`LLM INDEPENDENT ASSESSMENT: ${llmResponse.bl_type || "N/A"}`);
            parts.push(`LLM Suggested Threshold: ${llmResponse.threshold_value || "N/A"}`);

            return parts.join("\n");
          };

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
            evaluation_rationale: buildEvaluationRationale(),
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
            evaluation_rationale: `Error during LLM evaluation: ${error.message}`,
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