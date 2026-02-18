/*
  # Add Custom Audit Fields

  1. Changes to `audit_results` table
    - Add `business_mcat_key` (integer) - Indicates if Business MCAT override applies
    - Add `mcat_type` (text) - Either "Standard MCAT" or "Business MCAT"
    - Add `threshold_value` (text) - Formatted threshold value with unit or "NA"
    - Alter `llm_threshold_value` from numeric to text - To support formatted values

  2. Purpose
    - Support the custom audit prompt requirements
    - Enable Business MCAT override logic tracking
    - Store formatted threshold values with units
*/

DO $$
BEGIN
  -- Add business_mcat_key column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_results' AND column_name = 'business_mcat_key'
  ) THEN
    ALTER TABLE audit_results ADD COLUMN business_mcat_key integer DEFAULT 0;
  END IF;

  -- Add mcat_type column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_results' AND column_name = 'mcat_type'
  ) THEN
    ALTER TABLE audit_results ADD COLUMN mcat_type text DEFAULT 'Standard MCAT';
  END IF;

  -- Add threshold_value column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_results' AND column_name = 'threshold_value'
  ) THEN
    ALTER TABLE audit_results ADD COLUMN threshold_value text DEFAULT 'NA';
  END IF;

  -- Alter llm_threshold_value to text if it's currently numeric
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_results' 
    AND column_name = 'llm_threshold_value'
    AND data_type = 'numeric'
  ) THEN
    ALTER TABLE audit_results ALTER COLUMN llm_threshold_value TYPE text USING llm_threshold_value::text;
  END IF;
END $$;