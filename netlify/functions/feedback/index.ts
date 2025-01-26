import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { isValidOrigin } from './validation';

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

function getCorsHeaders(origin: string | undefined) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
    'Vary': 'Origin'
  };
}

async function validateFormId(formId: string, origin: string): Promise<boolean> {
  try {
    const { data: form } = await supabase
      .from('forms')
      .select('url')
      .eq('id', formId)
      .single();

    if (!form) return false;
    return isValidOrigin(origin, form.url);
  } catch {
    return false;
  }
}

export const handler: Handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin;
  const headers = getCorsHeaders(origin);

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  try {
    // Validate request
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const { 
      formId, 
      message, 
      image_url,
      image_name,
      image_size,
      operating_system, 
      screen_category,
      user_id,
      user_email,
      user_name 
    } = body;

    if (!formId || !message?.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid request data' })
      };
    }

    // Validate origin
    if (origin) {
      const isValid = await validateFormId(formId, origin);
      if (!isValid) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Origin not allowed' })
        };
      }
    }

    // Get notification URL from environment variable
    const notificationUrl = process.env.NOTIFICATION_URL || 'https://userbird.co/.netlify/functions/send-notification';

    // Store feedback
    const { error: insertError, data: feedbackData } = await supabase
      .from('feedback')
      .insert([{ 
        form_id: formId, 
        message,
        operating_system: operating_system || 'Unknown',
        image_url: image_url || null,
        image_name: image_name || null,
        image_size: image_size || null,
        screen_category: screen_category || 'Unknown',
        user_id: user_id || null,
        user_email: user_email || null,
        user_name: user_name || null
      }]);

    if (insertError) throw insertError;

    // Send success response immediately
    const response = {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };

    // Send notification
    if (feedbackData) {
      // Fire and forget notification
      console.log('Environment check:', {
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        hasSupabaseUrl: !!process.env.VITE_SUPABASE_URL,
        netlifyUrl: process.env.URL,
        functionUrl: notificationUrl,
        hasNotificationUrl: !!process.env.NOTIFICATION_URL
      });

      const notificationData = {
        formId,
        message,
        userName: user_name,
        userEmail: user_email,
        operating_system,
        screen_category,
        image_url,
        created_at: feedbackData[0].created_at
      };

      console.log('Sending notification with data:', notificationData);
      
      await fetch(notificationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify(notificationData)
      }).then(async (response) => {
        const text = await response.text();
        console.log('Notification endpoint response:', {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          text: text.slice(0, 200), // Log first 200 chars of response
          url: notificationUrl
        });
        if (!response.ok) {
          throw new Error(`Notification failed: ${response.status} ${text}`);
        }
      }).catch((error) => {
        console.error('Notification request failed:', {
          error: error instanceof Error ? error.message : 'Unknown error',
          url: notificationUrl,
          env: {
            hasUrl: !!process.env.URL,
            url: process.env.URL,
            hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
            hasSupabaseUrl: !!process.env.VITE_SUPABASE_URL
          },
          stack: error instanceof Error ? error.stack : undefined
        });
      });
      
      console.log('Notification request completed');
    }

    return response;
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};