const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

let docClient;
const tableName = process.env.TABLE_NAME;

try {
    const client = new DynamoDBClient({});
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
    if (!docClient || !tableName) {
        return buildResponse(500, { error: "Internal server configuration error. Database reference missing." });
    }

    const method = event.requestContext?.http?.method || event.httpMethod;
    console.info("EVENT\n" + JSON.stringify(event, null, 2));
    if (method === 'GET') {
        try {
            // Because the route is /items/{id}, we pull from pathParameters, not queryStringParameters
            const sessionId = event.pathParameters?.id;

            if (!sessionId) {
                console.warn("GET request missing 'id' path parameter.");
                return buildResponse(400, { error: "Missing required 'id' in the URL path." });
            }

            console.info(`Attempting to fetch session ID '${sessionId}' from table '${tableName}'...`);
            
            const command = new GetCommand({
                TableName: tableName,
                Key: { id: sessionId }
            });

            const response = await docClient.send(command);

            if (response.Item) {
                console.info(`Successfully retrieved session ID: ${sessionId}`);
                
                // Optional: Strip the userId out before returning if you don't want to expose it publicly
                delete response.Item.userId;
                
                return buildResponse(200, response.Item);
            } else {
                console.warn(`Session ID '${sessionId}' not found.`);
                return buildResponse(404, { error: "Session not found." });
            }

        } catch (error) {
            console.error(`AWS DynamoDB Error during GET [${error.name}]: ${error.message}`);
            return buildResponse(500, { error: "Database error occurred during read.", code: error.name });
        }
    } else {
        return buildResponse(405, { error: `HTTP method '${method}' is not supported on this public endpoint.` });
    }
};

const buildResponse = (statusCode, bodyDict) => {
    return {
        statusCode: statusCode,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(bodyDict)
    };
};