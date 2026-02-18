/*
  # Data Audit System Schema

  ## Overview
  This migration creates the complete database schema for an AI-powered data audit system that processes retail audit data against threshold reference values.

  ## New Tables

  ### 1. `audit_sessions`
  Tracks individual audit runs/sessions
  - `id` (uuid, primary key) - Unique session identifier
  - `session_name` (text) - User-friendly name for the audit
  - `status` (text) - Current status: 'uploading', 'processing', 'completed', 'failed'
  - `raw_data_count` (integer) - Number of records in raw data
  - `results_count` (integer) - Number of audit results generated
  - `created_at` (timestamptz) - Session creation timestamp
  - `completed_at` (timestamptz) - Session completion timestamp
  - `error_message` (text) - Error details if status is 'failed'

  ### 2. `raw_audit_data`
  Stores uploaded raw retail audit data
  - `id` (uuid, primary key) - Unique record identifier
  - `session_id` (uuid, foreign key) - Links to audit_sessions
  - `eto_ofr_display_id` (text) - Unique ID for posted buylead
  - `eto_ofr_approv_date_orig` (timestamptz) - Buylead posting date
  - `fk_glcat_mcat_id` (text) - Category ID mapping
  - `eto_ofr_glcat_mcat_name` (text) - Category name
  - `quantity` (numeric) - Requirement quantity
  - `quantity_unit` (text) - Quantity measurement unit
  - `probable_order_value` (text) - Calculated price range
  - `bl_segment` (text) - System retail marking
  - `bl_details` (text) - Complete buylead details
  - `created_at` (timestamptz) - Record creation timestamp

  ### 3. `threshold_data`
  Stores reference threshold values for categories
  - `id` (uuid, primary key) - Unique threshold identifier
  - `session_id` (uuid, foreign key) - Links to audit_sessions
  - `fk_glcat_mcat_id` (text) - Category ID
  - `glcat_mcat_name` (text) - Category name
  - `leap_retail_qty_cutoff` (numeric) - Threshold value
  - `gl_unit_name` (text) - Unit for threshold measurement
  - `created_at` (timestamptz) - Record creation timestamp

  ### 4. `audit_results`
  Stores the final audit outcomes
  - `id` (uuid, primary key) - Unique result identifier
  - `session_id` (uuid, foreign key) - Links to audit_sessions
  - `raw_data_id` (uuid, foreign key) - Links to raw_audit_data
  - `eto_ofr_display_id` (text) - Reference to original buylead
  - `fk_glcat_mcat_id` (text) - Category ID
  - `category_name` (text) - Category name
  - `quantity` (numeric) - Original quantity
  - `quantity_unit` (text) - Original unit
  - `bl_segment` (text) - Original segment marking
  
  **Indiamart Logic Results:**
  - `indiamart_audit_outcome` (text) - Pass/Fail based on threshold
  - `threshold_available` (boolean) - Whether threshold exists in sheet
  - `indiamart_category` (text) - Classification result
  - `indiamart_reason` (text) - AI reasoning for classification
  
  **LLM Logic Results:**
  - `llm_bl_type` (text) - AI classification (retail/non-retail)
  - `llm_threshold_value` (numeric) - AI-suggested threshold
  - `llm_threshold_reason` (text) - Reasoning for threshold value
  
  - `created_at` (timestamptz) - Result creation timestamp

  ## Security
  - Enable RLS on all tables
  - Public access for demo purposes (can be restricted later)

  ## Indexes
  - Index on session_id for all child tables
  - Index on category IDs for faster lookups
*/

-- Create audit_sessions table
CREATE TABLE IF NOT EXISTS audit_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_name text NOT NULL DEFAULT 'Audit Session',
  status text NOT NULL DEFAULT 'uploading',
  raw_data_count integer DEFAULT 0,
  results_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  error_message text,
  CONSTRAINT valid_status CHECK (status IN ('uploading', 'processing', 'completed', 'failed'))
);

-- Create raw_audit_data table
CREATE TABLE IF NOT EXISTS raw_audit_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  eto_ofr_display_id text NOT NULL,
  eto_ofr_approv_date_orig timestamptz,
  fk_glcat_mcat_id text NOT NULL,
  eto_ofr_glcat_mcat_name text,
  quantity numeric,
  quantity_unit text,
  probable_order_value text,
  bl_segment text,
  bl_details text,
  created_at timestamptz DEFAULT now()
);

-- Create threshold_data table
CREATE TABLE IF NOT EXISTS threshold_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  fk_glcat_mcat_id text NOT NULL,
  glcat_mcat_name text,
  leap_retail_qty_cutoff numeric,
  gl_unit_name text,
  created_at timestamptz DEFAULT now()
);

-- Drop and recreate audit_results with all columns
-- WARNING: This will delete all existing data in the table
DROP TABLE IF EXISTS audit_results CASCADE;

CREATE TABLE audit_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  raw_data_id uuid NOT NULL REFERENCES raw_audit_data(id) ON DELETE CASCADE,
  eto_ofr_display_id text NOT NULL,
  fk_glcat_mcat_id text,
  category_name text,
  quantity numeric,
  quantity_unit text,
  bl_segment text,
  business_mcat_key integer,
  mcat_type text,
  indiamart_audit_outcome text,
  threshold_available boolean,
  threshold_value text,
  indiamart_category text,
  indiamart_reason text,
  llm_bl_type text,
  llm_threshold_value text,  -- Changed to TEXT to accommodate unit strings
  llm_threshold_reason text,
  evaluation_rationale text,
  created_at timestamptz DEFAULT now()
);

-- Recreate the index
CREATE INDEX IF NOT EXISTS idx_audit_results_session ON audit_results(session_id);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_raw_audit_data_session ON raw_audit_data(session_id);
CREATE INDEX IF NOT EXISTS idx_raw_audit_data_category ON raw_audit_data(fk_glcat_mcat_id);
CREATE INDEX IF NOT EXISTS idx_threshold_data_session ON threshold_data(session_id);
CREATE INDEX IF NOT EXISTS idx_threshold_data_category ON threshold_data(fk_glcat_mcat_id);
CREATE INDEX IF NOT EXISTS idx_audit_results_session ON audit_results(session_id);

-- Enable Row Level Security
ALTER TABLE audit_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_audit_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE threshold_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_results ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (demo mode)
CREATE POLICY "Allow public read access to audit_sessions"
  ON audit_sessions FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public insert to audit_sessions"
  ON audit_sessions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow public update to audit_sessions"
  ON audit_sessions FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public read access to raw_audit_data"
  ON raw_audit_data FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public insert to raw_audit_data"
  ON raw_audit_data FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow public read access to threshold_data"
  ON threshold_data FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public insert to threshold_data"
  ON threshold_data FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow public read access to audit_results"
  ON audit_results FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public insert to audit_results"
  ON audit_results FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);