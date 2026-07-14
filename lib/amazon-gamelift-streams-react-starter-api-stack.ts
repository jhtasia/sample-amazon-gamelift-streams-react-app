// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as log from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class AmazonGameliftStreamsReactStarterAPIStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Use existing Passwordless Cognito User Pool from jht-office-portal (us-east-1)
        const userPool = cognito.UserPool.fromUserPoolId(
            this, 'PasswordlessUserPool', 'us-east-1_An6wcJWTe'
        );

        // create RestAPI for the frontend to start and get stream sessions
        // create a Cognito Authorizer for our API
        const auth = new apigateway.CognitoUserPoolsAuthorizer(this, 'gamelift-streams-react-starter-authorized', {
            cognitoUserPools: [userPool]
        });

        const api = new apigateway.RestApi(this, 'gamelift-streams-react-starter-api', {
            restApiName: this.stackName + '-gamelift-streams-react-starter-api',
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS
            },
            cloudWatchRole: true
        });

        // add cors header to default 504 response for integration timeouts
        api.addGatewayResponse('gw-timeout-cors-headers', {
            type: apigateway.ResponseType.INTEGRATION_TIMEOUT,
            statusCode: '504',
            responseHeaders: {
                'Access-Control-Allow-Origin': '\'*\'',
                'Access-Control-Allow-Headers': '\'*\'',
                'Access-Control-Allow-Methods': '\'*\''
            }
        });

        // create lambda functions
        const lambdaLogGroup = new log.LogGroup(this, 'gamelift-streams-react-starter-lambda-log-group', {
            logGroupName: this.stackName + '/lambda',
            retention: log.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });

        // DynamoDB table for game list
        const gamesTable = new dynamodb.Table(this, 'gamelift-streams-games-table', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 1. Create the DynamoDB Table
        const telemetryTable = new dynamodb.Table(this, 'DataVisTelemetryTable', {
        // The partition key must match the 'id' field we used in the JavaScript code
        partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Cost-effective serverless billing
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Safe for dev: deletes table if stack is destroyed
        });

        // 2. Create the Lambda Function
        const telemetryLambda = new lambda.Function(this, 'dataviz-get-data-lambda', {
          runtime: lambda.Runtime.NODEJS_24_X,
        
          // This tells CDK to look for a folder named "lambda" in the root of the project
          code: lambda.Code.fromAsset('lambda/SaveData'), 
        
          // "index.handler" means: look for a file named "index" and call the exported "handler" function
          handler: 'SaveData.handler', 
        
          // Pass the dynamically generated table name into the Lambda's process.env
          environment: {
            TABLE_NAME: telemetryTable.tableName,
          },
        });
        telemetryTable.grantReadWriteData(telemetryLambda);

        const startStreamLambda = new lambda.Function(this, 'gamelift-streams-start-stream-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: 'StartStream.handler',
            code: lambda.Code.fromAsset('lambda/StartStream'),
            timeout: cdk.Duration.seconds(10),
            environment: {
                'CONNECTION_TIMEOUT': '10',
            },
            logGroup: lambdaLogGroup,
        });

        startStreamLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['gameliftstreams:StartStreamSession', 'gameliftstreams:GetStreamSession'],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }));

        // add the lambda as post action
        api.root.addMethod('POST', new apigateway.LambdaIntegration(startStreamLambda, {
            timeout: cdk.Duration.seconds(10)
        }), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });
        // 4. Create the new '/telemetry' URL path on the existing API
        const telemetryResource = api.root.addResource('items');

        // 5. Tell the API Gateway to trigger your Lambda function whenever someone hits that URL
        // Using 'ANY' allows it to handle both GET (fetching data) and POST/PUT (saving data)
        telemetryResource.addMethod('ANY', new apigateway.LambdaIntegration(telemetryLambda));

        const session = api.root.addResource('session');
        const sgParam = session.addResource('{sg}');
        const arnParam = sgParam.addResource('{arn}');

        const getStreamLambda = new lambda.Function(this, 'gamelift-streams-get-stream-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: 'GetStream.handler',
            code: lambda.Code.fromAsset('lambda/GetStream'),
            timeout: cdk.Duration.seconds(10),
            logGroup: lambdaLogGroup
        });

        getStreamLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['gameliftstreams:GetStreamSession'],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }));

        arnParam.addMethod('GET', new apigateway.LambdaIntegration(getStreamLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });

        const reconnect = api.root.addResource('reconnect');

        const createStreamSessionConnection = new lambda.Function(this, 'gamelift-streams-create-stream-connection-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: 'CreateStreamSessionConnection.handler',
            code: lambda.Code.fromAsset('lambda/CreateStreamSessionConnection'),
            timeout: cdk.Duration.seconds(120),
            logGroup: lambdaLogGroup
        });

        createStreamSessionConnection.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['gameliftstreams:CreateStreamSessionConnection'],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }));

        reconnect.addMethod('POST', new apigateway.LambdaIntegration(createStreamSessionConnection), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });

        const games = api.root.addResource('games');

        const listGamesLambda = new lambda.Function(this, 'gamelift-streams-list-games-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: 'ListGames.handler',
            code: lambda.Code.fromAsset('lambda/ListGames'),
            timeout: cdk.Duration.seconds(10),
            environment: {
                'GAMES_TABLE_NAME': gamesTable.tableName,
            },
            logGroup: lambdaLogGroup
        });

        gamesTable.grantReadData(listGamesLambda);

        games.addMethod('GET', new apigateway.LambdaIntegration(listGamesLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });

        // outputs
        const endpointUrl = api.urlForPath('/');
        new cdk.CfnOutput(this, 'Endpoint', {
            value: endpointUrl.endsWith('/') ? endpointUrl.slice(0, -1) : endpointUrl  // remove trailing slash
        });


        /**
        * Nag Suppressions
        */
        NagSuppressions.addResourceSuppressions(api, [
            {
                id: 'AwsSolutions-APIG4',
                reason: 'CORS Preflight Resource, does not require authorizer',
            },
            {
                id: 'AwsSolutions-COG4',
                reason: 'CORS Preflight Resource, does not require authorizer'
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'API Gateway REST API is using the Amazon Managed Policy: service-role/AmazonAPIGatewayPushToCloudWatchLogs.',
            },
            {
                id: 'AwsSolutions-APIG2',
                reason: 'API Gateway REST API methods.',
            },
            {
                id: 'AwsSolutions-APIG1',
                reason: 'Access logging is not required for this sample application. In production, enable access logging for audit purposes.'
            },
            {
                id: 'AwsSolutions-APIG3',
                reason: 'WAF is not required for this sample application. In production, implement WAF for additional security.'
            },
            {
                id: 'AwsSolutions-APIG6',
                reason: 'CloudWatch logging is not required for this sample application. In production, enable CloudWatch logging for all methods.'
            }
        ], true);
  
        NagSuppressions.addResourceSuppressions(startStreamLambda, [
            {
                id: "AwsSolutions-IAM5",
                reason: "startStreamLambda uses IAM RolePolicy that contains wildcard, but hardened to account level least priviledge."
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application. In production, consider using custom IAM policies.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            }
        ], true);

        NagSuppressions.addResourceSuppressions(getStreamLambda, [
            {
                id: "AwsSolutions-IAM5",
                reason: "getStreamLambda uses IAM RolePolicy that contains wildcard, but hardened to account level least priviledge."
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application. In production, consider using custom IAM policies.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            }
        ], true);

        NagSuppressions.addResourceSuppressions(gamesTable, [
            {
                id: 'AwsSolutions-DDB3',
                reason: 'Point-in-time recovery is not required for this sample application. In production, enable PITR for data protection.'
            }
        ], true);

        NagSuppressions.addResourceSuppressions(listGamesLambda, [
            {
                id: "AwsSolutions-IAM5",
                reason: "listGamesLambda uses IAM RolePolicy that contains wildcard for DynamoDB, but scoped to specific table."
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application. In production, consider using custom IAM policies.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            }
        ], true);

        NagSuppressions.addResourceSuppressions(createStreamSessionConnection, [
            {
                id: "AwsSolutions-IAM5",
                reason: "createStreamSessionConnection uses IAM RolePolicy that contains wildcard, but hardened to account level least priviledge."
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application. In production, consider using custom IAM policies.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            }
        ], true);
        NagSuppressions.addResourceSuppressions(telemetryLambda, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application. In production, consider using custom IAM policies.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            }
        ], true);

        NagSuppressions.addResourceSuppressions(telemetryTable, [
            {
                id: 'AwsSolutions-DDB3',
                reason: 'Point-in-time recovery is not required for this sample application. In production, enable PITR for data protection.'
            }
        ], true);
    }
}
