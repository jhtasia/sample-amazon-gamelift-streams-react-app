import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME || 'custom-memories-ai-coach-unity';

// Explicit headers guarantee CORS compliance across all browser security models
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,X-Requested-With',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,PUT,DELETE',
  'Content-Type': 'application/json'
};

export const handler = async (event) => {
  // Determine HTTP Method robustly across API Gateway v1 (REST) and v2 (HTTP)
  const httpMethod = event.httpMethod || event.requestContext?.http?.method;

  // 1. Handle HTTP OPTIONS preflight request immediately
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'CORS preflight successful' })
    };
  }

  try {
    // Check all possible places API Gateway could pass userId
    const userId = 
      event.queryStringParameters?.userId || 
      event.pathParameters?.userId ||
      event.pathParameters?.proxy ||
      event.requestContext?.authorizer?.claims?.sub ||
      event.requestContext?.authorizer?.jwt?.claims?.sub;

    if (!userId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing required parameter: userId' })
      };
    }

    const stateKey = `states/${userId}/user_state.md`;
    console.log(`Fetching user state from S3: s3://${BUCKET_NAME}/${stateKey}`);

    // Read object from S3
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: stateKey
    });

    const s3Response = await s3Client.send(command);
    const userStateMarkdown = await s3Response.Body.transformToString();

    // Return successful response to frontend
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        userId: userId,
        userState: userStateMarkdown
      })
    };

  } catch (error) {
    console.error('Error retrieving user state:', error);

    // Handle 404 (User state file does not exist yet)
    if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'User state not found',
          userId: event.queryStringParameters?.userId || null
        })
      };
    }

    // Handle generic server errors
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to retrieve user state' })
    };
  }
};