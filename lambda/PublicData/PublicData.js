const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

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
            const sessionId = event.pathParameters?.id;

            if (!sessionId) {
                console.warn("GET request missing 'id' path parameter.");
                return buildResponse(400, { error: "Missing required 'id' in the URL path." });
            }

            console.info(`Attempting to fetch chunked entries for session ID '${sessionId}' from table '${tableName}'...`);

            // Fetch all chunks for this session ID, handling pagination automatically
            const allItems = await fetchAllChunks(sessionId);

            if (!allItems || allItems.length === 0) {
                console.warn(`Session ID '${sessionId}' not found.`);
                return buildResponse(404, { error: "Session not found." });
            }

            console.info(`Successfully retrieved ${allItems.length} chunk(s) for session ID: ${sessionId}`);

            // Reassemble the chunked items/events into a single payload
            const assembledSession = reassembleChunks(allItems);

            return buildResponse(200, assembledSession);

        } catch (error) {
            console.error(`AWS DynamoDB Error during GET [${error.name}]: ${error.message}`);
            return buildResponse(500, { error: "Database error occurred during read.", code: error.name });
        }
    } else {
        return buildResponse(405, { error: `HTTP method '${method}' is not supported on this public endpoint.` });
    }
};

/**
 * Queries DynamoDB for all chunks associated with the partition key `id = sessionId`.
 * Handles pagination (LastEvaluatedKey) to ensure large datasets spanning multiple items are fully fetched.
 */
async function fetchAllChunks(sessionId) {
    let items = [];
    let lastEvaluatedKey = null;

    do {
        const queryParams = {
            TableName: tableName,
            KeyConditionExpression: "id = :sessionId",
            ExpressionAttributeValues: {
                ":sessionId": sessionId
            },
            ExclusiveStartKey: lastEvaluatedKey
        };

        const command = new QueryCommand(queryParams);
        const response = await docClient.send(command);

        if (response.Items && response.Items.length > 0) {
            items.push(...response.Items);
        }

        lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return items;
}

/**
 * Sorts chunks by sequence/index, strips sensitive metadata, 
 * and merges chunked attributes or arrays into a single response object.
 */
function reassembleChunks(items) {
    // 1. Sort items by chunkIndex, sequence, or timestamp if available
    items.sort((a, b) => {
        const seqA = a.chunkIndex ?? a.sequence ?? a.timestamp ?? 0;
        const seqB = b.chunkIndex ?? b.sequence ?? b.timestamp ?? 0;
        return seqA - seqB;
    });

    // 2. Base payload initialized with shared metadata from the first item
    const baseItem = { ...items[0] };

    // Strip sensitive or chunk-specific fields from the primary base item
    delete baseItem.userId;
    delete baseItem.Metadata;
    delete baseItem.userEmail;
    delete baseItem.chunkIndex;
    delete baseItem.sequence;

    // 3. Reconstruct chunked arrays or strings across items
    let concatenatedEvents = [];
    let combinedContent = "";

    for (const item of items) {
        // Handle events array across chunks
        if (Array.isArray(item.events)) {
            concatenatedEvents.push(...item.events);
        } else if (Array.isArray(item.data)) {
            concatenatedEvents.push(...item.data);
        }

        // Handle string content/payload chunks
        if (typeof item.content === 'string') {
            combinedContent += item.content;
        }
    }

    // Assign combined data back to response if chunks contained aggregated lists or content
    if (concatenatedEvents.length > 0) {
        baseItem.events = concatenatedEvents;
    }
    if (combinedContent.length > 0) {
        baseItem.content = combinedContent;
    }

    return baseItem;
}

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