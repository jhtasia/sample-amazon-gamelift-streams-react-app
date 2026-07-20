const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

let docClient;
const tableName = process.env.TABLE_NAME;
const indexName = process.env.INDEX_NAME; // Required for querying by userId

try {
    const client = new DynamoDBClient({});
    docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true }
    });

    if (!tableName || !indexName) {
        console.error("Environment variables 'TABLE_NAME' or 'INDEX_NAME' are missing.");
    }
} catch (initError) {
    console.error(`Failed to initialize DynamoDB resource: ${initError.message}`);
}

exports.handler = async (event, context) => {
    if (!docClient || !tableName) {
        return buildResponse(500, { error: "Internal server configuration error. Database reference missing." });
    }

    // Extract the User ID from the Cognito token claims securely passed by API Gateway
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
        return buildResponse(401, { error: "Unauthorized. Missing user identity." });
    }

    const method = event.requestContext?.http?.method || event.httpMethod;

    // ==========================================
    // GET METHOD: FETCH ALL DATA FOR USER
    // ==========================================
    if (method === 'GET') {
        try {
            console.info(`Fetching all sessions for user '${userId}' from table '${tableName}' using index '${indexName}'...`);
            
            const command = new QueryCommand({
                TableName: tableName,
                IndexName: indexName,
                KeyConditionExpression: "userId = :uid",
                ExpressionAttributeValues: {
                    ":uid": userId
                }
            });

            const response = await docClient.send(command);

            console.info(`Successfully retrieved ${response.Items.length} sessions for user: ${userId}`);
            return buildResponse(200, response.Items);

        } catch (error) {
            console.error(`AWS DynamoDB Error during GET [${error.name}]: ${error.message}`);
            return buildResponse(500, { error: "Database error occurred during read.", code: error.name });
        }
    }

    // ==========================================
    // POST/PUT METHOD: SAVE DATA FOR USER
    // ==========================================
    else if (method === 'POST' || method === 'PUT') {
        try {
            if (!event.body) {
                return buildResponse(400, { error: "Invalid request. Request body cannot be empty." });
            }
                
            const payload = JSON.parse(event.body);

            const requiredFields = ['id', 'Timestamp', 'Records'];
            const missingFields = requiredFields.filter(field => !(field in payload));
            
            if (missingFields.length > 0) {
                return buildResponse(400, { error: `Missing required payload fields: ${missingFields.join(', ')}` });
            }

            if (!Array.isArray(payload.Records)) {
                return buildResponse(400, { error: "'Records' field must be a valid JSON array." });
            }

            // CRITICAL: Attach the Cognito User ID to the payload so the GSI can index it
            payload.userId = userId;

            console.info(`Attempting to write session ID '${payload.id}' for user '${userId}'...`);
            
            const command = new PutCommand({
                TableName: tableName,
                Item: payload
            });

            await docClient.send(command);
            
            return buildResponse(200, {
                message: "Session successfully synced!",
                id: payload.id
            });

        } catch (error) {
            if (error instanceof SyntaxError) {
                return buildResponse(400, { error: "Malformed JSON. Please check your serialization format." });
            }
            return handleDynamoDBError(error);
        }
    }

    else {
        return buildResponse(405, { error: `HTTP method '${method}' is not supported on this endpoint.` });
    }
};

const buildResponse = (statusCode, bodyDict) => {
    return {
        statusCode: statusCode,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(bodyDict)
    };
};

const handleDynamoDBError = (error) => {
    const errorCode = error.name;
    console.error(`AWS DynamoDB Error [${errorCode}]: ${error.message}`);
    if (errorCode === 'ValidationException') return buildResponse(400, { error: "Data validation error inside database.", details: error.message });
    if (errorCode === 'ResourceNotFoundException') return buildResponse(500, { error: "Target database table not found." });
    if (errorCode === 'ProvisionedThroughputExceededException') return buildResponse(503, { error: "Database is temporarily overloaded." });
    if (errorCode === 'AccessDeniedException') return buildResponse(500, { error: "Server permission failure." });
    return buildResponse(500, { error: "Database error occurred.", code: errorCode });
};