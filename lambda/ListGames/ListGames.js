// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { Logger } = require('@aws-lambda-powertools/logger');

const logger = new Logger({ serviceName: 'list-games' });
const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

function defaultHeader() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    };
}

exports.handler = async function(event, context) {
    logger.addContext(context);
    try {
        const tableName = process.env.GAMES_TABLE_NAME;
        const command = new ScanCommand({ TableName: tableName });
        const result = await docClient.send(command);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                ...defaultHeader()
            },
            body: JSON.stringify(result.Items ?? [])
        };
    } catch (e) {
        logger.error('Something went wrong: ', e);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                ...defaultHeader()
            },
            body: JSON.stringify({ 'message': e.message })
        };
    }
};
