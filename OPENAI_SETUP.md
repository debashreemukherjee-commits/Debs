# OpenAI API Key Setup

This application uses ChatGPT to power the AI audit analysis. You need to configure your OpenAI API key to enable this functionality.

## Steps to Configure

### 1. Get Your OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Sign in or create an account
3. Navigate to **API Keys** section
4. Click **Create new secret key**
5. Copy the generated API key (it starts with `sk-`)

### 2. Configure the API Key in Supabase

The OpenAI API key needs to be set as a secret in your Supabase project:

1. Go to your [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. Navigate to **Project Settings** → **Edge Functions** → **Secrets**
4. Add a new secret:
   - **Name**: `OPENAI_API_KEY`
   - **Value**: Your OpenAI API key (e.g., `sk-...`)
5. Click **Save**

## How It Works

When you run an audit:

1. Your custom audit prompt is sent to the ChatGPT edge function
2. The edge function processes each record using ChatGPT (gpt-4o-mini model)
3. ChatGPT analyzes:
   - Whether the record should be classified as "Retail" or "Non-Retail"
   - Appropriate threshold values (if not available)
   - Detailed reasoning for the classification
4. Results are saved to your database and displayed in the UI

## Cost Considerations

- The app uses **gpt-4o-mini** which is cost-effective
- Approximately 10 records are processed in parallel batches
- Each record costs approximately $0.0001-0.0003 per audit
- For 1000 records, expect costs around $0.10-0.30

## Troubleshooting

**Error: "OPENAI_API_KEY is not configured"**
- Make sure you've added the API key to Supabase Edge Function secrets
- Redeploy the edge function after adding the secret

**Error: "OpenAI API error: 401"**
- Your API key is invalid or expired
- Generate a new API key from OpenAI Platform
- Update the secret in Supabase

**Error: "OpenAI API error: 429"**
- You've exceeded your API rate limit or quota
- Check your OpenAI account usage and billing
- Consider upgrading your OpenAI plan
