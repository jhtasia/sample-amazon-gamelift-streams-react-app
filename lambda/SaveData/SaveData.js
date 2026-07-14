const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

// Initialize the DynamoDB resource outside the handler for connection reuse
let docClient;
const tableName = process.env.TABLE_NAME;

try {
    const client = new DynamoDBClient({});
    
    // The DocumentClient automatically handles standard JSON number-to-DynamoDB conversions
    docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true }
    });

    if (!tableName) {
        console.error("Environment variable 'TABLE_NAME' is missing.");
    }
} catch (initError) {
    console.error(`Failed to initialize DynamoDB resource: ${initError.message}`);
}

exports.handler = async (event, context) => {
    // 1. Verify table initialization succeeded
    if (!docClient || !tableName) {
        return buildResponse(500, { error: "Internal server configuration error. Database reference missing." });
    }

    // 2. Determine the HTTP Method 
    const method = event.requestContext?.http?.method || event.httpMethod;

    // ==========================================
    // GET METHOD: FETCH DATA
    // ==========================================
    if (method === 'GET') {
        try {
            const queryParams = event.queryStringParameters || {};
            const sessionId = queryParams.id;

            if (!sessionId) {
                console.warn("GET request missing 'id' parameter.");
                return buildResponse(400, { error: "Missing required 'id' query parameter. Append ?id=YOUR_ID to the URL." });
            }

            console.info(`Attempting to fetch session ID '${sessionId}' from table '${tableName}'...`);
            
            const command = new GetCommand({
                TableName: tableName,
                Key: { id: sessionId }
            });

            const response = await docClient.send(command);

            if (response.Item) {
                console.info(`Successfully retrieved session ID: ${sessionId}`);
                return buildResponse(200, response.Item);
            } else {
                console.warn(`Session ID '${sessionId}' not found.`);
                return buildResponse(404, { error: "Session not found." });
            }

        } catch (error) {
            console.error(`AWS DynamoDB Error during GET [${error.name}]: ${error.message}`);
            return buildResponse(500, { error: "Database error occurred during read.", code: error.name });
        }
    }

    // ==========================================
    // POST/PUT METHOD: SAVE DATA
    // ==========================================
    else if (method === 'POST' || method === 'PUT') {
        try {
            if (!event.body) {
                console.warn("Received request with an empty or missing body.");
                return buildResponse(400, { error: "Invalid request. Request body cannot be empty." });
            }
                
            const payload = JSON.parse(event.body);
            console.info(`Successfully parsed incoming JSON payload for request ID: ${context.awsRequestId}`);

            const requiredFields = ['id', 'Timestamp', 'Records'];
            const missingFields = requiredFields.filter(field => !(field in payload));
            
            if (missingFields.length > 0) {
                console.warn(`Validation failed. Missing fields: ${missingFields.join(', ')}`);
                return buildResponse(400, { error: `Missing required payload fields: ${missingFields.join(', ')}` });
            }

            if (!Array.isArray(payload.Records)) {
                console.warn("Validation failed. 'Records' field is not an array/list.");
                return buildResponse(400, { error: "'Records' field must be a valid JSON array." });
            }

            console.info(`Attempting to write session ID '${payload.id}' to DynamoDB table '${tableName}'...`);
            
            const command = new PutCommand({
                TableName: tableName,
                Item: payload
            });

            await docClient.send(command);
            
            console.info(`Successfully saved session ID: ${payload.id}`);
            return buildResponse(200, {
                message: "Session successfully synced!",
                id: payload.id
            });

        } catch (error) {
            if (error instanceof SyntaxError) {
                console.error(`Malformed JSON payload: ${error.message} | Raw body: ${event.body}`);
                return buildResponse(400, { error: "Malformed JSON. Please check your serialization format." });
            }

            const errorCode = error.name;
            const errorMessage = error.message;
            console.error(`AWS DynamoDB Error [${errorCode}]: ${errorMessage}`);

            if (errorCode === 'ValidationException') {
                return buildResponse(400, { error: "Data validation error inside database. Check data types like empty strings or specialized numbers.", details: errorMessage });
            } else if (errorCode === 'ResourceNotFoundException') {
                return buildResponse(500, { error: "Target database table not found. Please check AWS configuration." });
            } else if (errorCode === 'ProvisionedThroughputExceededException') {
                return buildResponse(503, { error: "Database is temporarily overloaded. Please retry later." });
            } else if (errorCode === 'AccessDeniedException') {
                return buildResponse(500, { error: "Server permission failure. Lambda execution role is missing required IAM policies." });
            } else {
                return buildResponse(500, { error: "Database error occurred.", code: errorCode });
            }
        }
    }

    // ==========================================
    // UNHANDLED METHODS
    // ==========================================
    else {
        console.warn(`Unsupported HTTP method received: ${method}`);
        return buildResponse(405, { error: `HTTP method '${method}' is not supported on this endpoint.` });
    }
};

/**
 * Helper function to structure clean API Gateway responses.
 */
const buildResponse = (statusCode, bodyDict) => {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(bodyDict)
    };
};