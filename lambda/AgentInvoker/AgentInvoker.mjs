import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

// Initialize AWS Clients
const bedrockClient = new BedrockAgentCoreClient({ region: "ap-northeast-1" });
const s3Client = new S3Client({});

// Initialize Google Gen AI SDK
const GEMMA_API_KEY = process.env.GEMMA_API_KEY;
const genAI = new GoogleGenerativeAI(GEMMA_API_KEY);

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "custom-memories-ai-coach-unity";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
};

async function getUserState(userId) {
  const stateKey = `states/${userId}/user_state.md`;
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: stateKey });
    const response = await s3Client.send(command);
    return await response.Body.transformToString();
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
      return "# User State\n\nNo prior history.";
    }
    throw error;
  }
}

async function saveUserState(userId, updatedStateMd) {
  const stateKey = `states/${userId}/user_state.md`;
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: stateKey,
    Body: updatedStateMd,
    ContentType: 'text/markdown'
  });
  await s3Client.send(command);
}

// NEW: Function to save the analytics report to S3
async function saveAnalyticsReport(userId, reportMd) {
  const reportKey = `analytics/${userId}/sales_report.md`;
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    Body: reportMd,
    ContentType: 'text/markdown'
  });
  await s3Client.send(command);
}

async function callGemmaApi(currentState, userQuery, assistantResponse) {
  const stateSchema = {
    type: SchemaType.OBJECT,
    properties: {
      goals_and_targets: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: "Current active goals. Keep <goal> tags, but you MUST REMOVE goals that have been achieved, cancelled, or replaced by the user."
      },
      performance_metrics: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: "Metrics and benchmarks (e.g., Squat: 120kg)."
      },
      training_and_activity: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: "Current training focus and activity."
      },
      observations: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: "Energy, motivation, and compliance observations."
      }
    },
    required: ["goals_and_targets", "performance_metrics", "training_and_activity", "observations"]
  };

  const model = genAI.getGenerativeModel({
    model: "gemma-4-26b-a4b-it", // Using the latest official Gemma 2 model
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: stateSchema,
    },
  });

  const prompt = `
    You are a Health & Fitness Profile Manager. 
    Analyze the new interaction and update the user's state.

    --- CURRENT STATE ---
    ${currentState || "No prior history."}

    --- NEW INTERACTION MEMORIES ---
    User Prompt: ${userQuery}
    Assistant Response: ${assistantResponse}
  `;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const stateObj = JSON.parse(responseText);

    let newMarkdown = "# User State\n\n";
    
    newMarkdown += "## Goals & Targets\n";
    if (stateObj.goals_and_targets?.length) {
      stateObj.goals_and_targets.forEach(item => newMarkdown += `- ${item}\n`);
    } else {
      newMarkdown += "- No active goals.\n";
    }
    
    newMarkdown += "\n## Performance Benchmarks & Metrics\n";
    if (stateObj.performance_metrics?.length) {
      stateObj.performance_metrics.forEach(item => newMarkdown += `- ${item}\n`);
    } else {
      newMarkdown += "- No benchmarks recorded.\n";
    }
    
    newMarkdown += "\n## Training & Activity\n";
    if (stateObj.training_and_activity?.length) {
      stateObj.training_and_activity.forEach(item => newMarkdown += `- ${item}\n`);
    }
    
    newMarkdown += "\n## Observations & Health Status\n";
    if (stateObj.observations?.length) {
      stateObj.observations.forEach(item => newMarkdown += `- ${item}\n`);
    }

    return newMarkdown.trim();

  } catch (error) {
    console.error("GenAI State Update JSON Generation Failed:", error);
    return currentState; 
  }
}

// NEW: Function to generate the Gym Products Sales & Analytics Report
async function generateAnalyticsReport(updatedState, userQuery, assistantResponse) {
  const analyticsSchema = {
    type: SchemaType.OBJECT,
    properties: {
      user_segment: {
        type: SchemaType.STRING,
        description: "Categorize the user (e.g., Powerlifter, Endurance Runner, General Fitness, Beginner)."
      },
      equipment_interest: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: "Gym equipment explicitly mentioned or implicitly needed based on their workouts."
      },
      product_opportunities: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: "Specific gym products, supplements, or gear to market to this user."
      },
      churn_risk_level: {
        type: SchemaType.STRING,
        description: "Assess engagement level: Low, Medium, or High risk of quitting."
      }
    },
    required: ["user_segment", "equipment_interest", "product_opportunities", "churn_risk_level"]
  };

  const model = genAI.getGenerativeModel({
    model: "gemma-4-26b-a4b-it", 
    generationConfig: {
      temperature: 0.2, // Slightly higher temp for marketing recommendations
      responseMimeType: "application/json",
      responseSchema: analyticsSchema,
    },
  });

  const prompt = `
    You are a Data Analyst for a Gym Products & Supplements company.
    Based on the user's latest fitness profile and chat interaction, generate a sales and marketing intelligence report.

    --- USER FITNESS PROFILE ---
    ${updatedState}

    --- LATEST INTERACTION ---
    User Prompt: ${userQuery}
    Assistant Response: ${assistantResponse}
  `;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const analyticsObj = JSON.parse(responseText);

    // Format the JSON into a clean Markdown report for your analytics team
    let reportMd = "# User Analytics & Sales Report\n\n";
    reportMd += `**User Segment:** ${analyticsObj.user_segment}\n`;
    reportMd += `**Churn Risk Level:** ${analyticsObj.churn_risk_level}\n\n`;

    reportMd += "## Equipment Indicators\n";
    if (analyticsObj.equipment_interest?.length) {
      analyticsObj.equipment_interest.forEach(item => reportMd += `- ${item}\n`);
    } else {
      reportMd += "- No specific equipment needs identified.\n";
    }

    reportMd += "\n## Product & Supplement Opportunities\n";
    if (analyticsObj.product_opportunities?.length) {
      analyticsObj.product_opportunities.forEach(item => reportMd += `- ${item}\n`);
    } else {
      reportMd += "- No clear product opportunities at this time.\n";
    }

    return reportMd.trim();

  } catch (error) {
    console.error("GenAI Analytics JSON Generation Failed:", error);
    return "# Analytics Report\n\nFailed to generate report for this session."; 
  }
}

/**
 * REST API Gateway Response Streaming Handler
 */
export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const httpMethod = event.httpMethod || event.requestContext?.http?.method;
  
  if (httpMethod === "OPTIONS") {
    const metadata = { statusCode: 200, headers: corsHeaders };
    const responseStreamWithMetadata = awslambda.HttpResponseStream.from(responseStream, metadata);
    responseStreamWithMetadata.write(JSON.stringify({ message: "CORS preflight successful" }));
    responseStreamWithMetadata.end();
    return;
  }

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });

  let fullResponseText = "";

  try {
    const body = JSON.parse(event.body || "{}");
    const userQuery = body.query;
    const userId = event.requestContext?.authorizer?.claims?.sub || body.user_id || body.userId;
    const sessionId = body.sessionId || `session-${userId}`;

    if (!userQuery || !userId) {
      stream.write("Error: Query and user_id are required.");
      stream.end();
      return;
    }

    const command = new InvokeHarnessCommand({
      harnessArn: "arn:aws:bedrock-agentcore:ap-northeast-1:478946426939:harness/AICoachAmplifyDataviz-JpyyZ0Izei",
      runtimeSessionId: sessionId,
      actorId: userId,
      messages: [{ role: "user", content: [{ text: userQuery }] }],
    });

    const bedrockResponse = await bedrockClient.send(command);

    if (bedrockResponse.stream) {
      for await (const chunk of bedrockResponse.stream) {
        const textChunk = chunk.contentBlockDelta?.delta?.text || chunk.text || "";
        
        if (textChunk) {
          stream.write(textChunk);
          fullResponseText += textChunk;
        }
      }
    }

    const cleanedResponseText = fullResponseText
      ? fullResponseText.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim()
      : "No response generated by agent.";

    try {
      // 1. Update and save the standard fitness profile
      const currentState = await getUserState(userId);
      const updatedState = await callGemmaApi(currentState, body.rawQuery, cleanedResponseText);
      await saveUserState(userId, updatedState);

      // 2. Generate and save the new sales/analytics report based on the updated state
      const analyticsReport = await generateAnalyticsReport(updatedState, body.rawQuery, cleanedResponseText);
      await saveAnalyticsReport(userId, analyticsReport);

    } catch (stateErr) {
      console.error("Non-fatal background processing error:", stateErr);
    }

  } catch (error) {
    console.error("Handler error:", error);
    stream.write(`\n[Error: ${error.message}]`);
  } finally {
    stream.write("[DONE]a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211");
    stream.end();
  }
});