import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";

const bedrockClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || "ap-northeast-1" });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
};

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

  try {
    const body = JSON.parse(event.body || "{}");
    const userQuery = body.query || body.rawQuery;
    const userId = event.requestContext?.authorizer?.claims?.sub || body.user_id || body.userId;
    const sessionId = body.sessionId || `session-${userId}`;

    if (!userQuery || !userId) {
      stream.write("Error: Query and user_id are required.");
      stream.end();
      return;
    }

    const command = new InvokeHarnessCommand({
      harnessArn: process.env.AGENT_HARNESS_ARN,
      runtimeSessionId: sessionId,
      actorId: userId,
      memoryId: process.env.AGENT_MEMORY_ID, 
      messages: [{ role: "user", content: [{ text: userQuery }] }],
    });

    const bedrockResponse = await bedrockClient.send(command);

    if (bedrockResponse.stream) {
      for await (const chunk of bedrockResponse.stream) {
        const textChunk = chunk.contentBlockDelta?.delta?.text || chunk.text || "";
        if (textChunk) {
          stream.write(textChunk);
        }
      }
    }

  } catch (error) {
    console.error("Handler error:", error);
    stream.write(`\n[Error: ${error.message}]`);
  } finally {
    stream.write("[DONE]a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211");
    stream.end();
  }
});