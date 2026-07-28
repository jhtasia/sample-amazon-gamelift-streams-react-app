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
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as s3 from 'aws-cdk-lib/aws-s3';

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
        // Add this GSI to enable querying by user
        telemetryTable.addGlobalSecondaryIndex({
            indexName: 'userId-index',
            partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
        });

        // 2. Create the Lambda Function
        // Protected Lambda (POST new item, GET all items for user)
        const protectedTelemetryLambda = new lambda.Function(this, 'protected-telemetry-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            code: lambda.Code.fromAsset('lambda/ProtectedData'), // Update this path to your new handler
            handler: 'ProtectedData.handler',
            environment: {
                TABLE_NAME: telemetryTable.tableName,
                INDEX_NAME: 'userId-index', // Pass the GSI name for querying
            },
            logGroup: lambdaLogGroup,
        });
        telemetryTable.grantReadWriteData(protectedTelemetryLambda);

        // Public Lambda (GET item by ID only)
        const publicTelemetryLambda = new lambda.Function(this, 'public-telemetry-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            code: lambda.Code.fromAsset('lambda/PublicData'), // Update this path to your new handler
            handler: 'PublicData.handler',
            environment: {
                TABLE_NAME: telemetryTable.tableName,
            },
            logGroup: lambdaLogGroup,
        });
        telemetryTable.grantReadData(publicTelemetryLambda); // Only requires Read permissions
        const userStateBucket = s3.Bucket.fromBucketName(
            this, 'UserStateBucket', 'custom-memories-ai-coach-unity'
        );

        // 1. AgentReporter Lambda (GET /report)
        const agentReporterLambda = new lambda.Function(this, 'agent-reporter-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: 'reporter.handler',
            code: lambda.Code.fromAsset('lambda/AgentReporter'),
            timeout: cdk.Duration.seconds(15),
            environment: {
                BUCKET_NAME: userStateBucket.bucketName,
            },
            logGroup: lambdaLogGroup,
        });

        userStateBucket.grantRead(agentReporterLambda);

        // 2. AgentInvoker Lambda (POST /coach with Response Streaming)
        const agentInvokerLambda = new lambda.Function(this, 'agent-invoker-lambda', {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: 'coach.handler',
            code: lambda.Code.fromAsset('lambda/AgentInvoker'),
            timeout: cdk.Duration.seconds(600),
            environment: {
                BUCKET_NAME: userStateBucket.bucketName,
            },
            logGroup: lambdaLogGroup,
        });

        userStateBucket.grantReadWrite(agentInvokerLambda);

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
        // ==========================================
        // DATA VISUALIZATION FRONTEND (AWS AMPLIFY)
        // ==========================================
        const reportResource = api.root.addResource('report');
        reportResource.addMethod('GET', new apigateway.LambdaIntegration(agentReporterLambda, {
            proxy: true
        }), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });

        // POST /coach Route (With Native Response Streaming)
        const coachResource = api.root.addResource('coach');
        
        const streamingIntegration = new apigateway.LambdaIntegration(agentInvokerLambda, {
            proxy: true,
            responseTransferMode: apigateway.ResponseTransferMode.STREAM,
        });

        coachResource.addMethod('POST', streamingIntegration, {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });
        // 1. Define the core Amplify Application shell
        const dataVisApp = new amplify.CfnApp(this, 'IsolatedDataVisFrontend', {
            name: 'DataVisDashboard',
            // Update this with the exact GitHub repository link for your React graphs
            repository: 'https://github.com/jhtasia/amplify_unity_dataviz',

            // Context variable fallback in case the account lacks a global GitHub link
            accessToken: this.node.tryGetContext('githubToken') || undefined,

            // Automatically injects the live API URL into your React build environment variables
            environmentVariables: [
                {
                    name: 'REACT_APP_API_URL',
                    value: api.urlForPath('/items'), // Connects your frontend charts directly to this API!
                }
            ]
        });

        // 2. Define the deployment branch (tracking 'main')
        const mainBranch = new amplify.CfnBranch(this, 'DataVisMainBranch', {
            appId: dataVisApp.attrAppId,
            branchName: 'main',
            enableAutoBuild: true, // Tells Amplify to auto-deploy every time you push a git commit
        });

        // 3. Output the live URL to your terminal once deployment finishes
        new cdk.CfnOutput(this, 'DataVisDashboardUrl', {
            value: `https://main.${dataVisApp.attrDefaultDomain}`,
            description: 'The live public link to your data visualization frontend dashboard',
        });
        const telemetryResource = api.root.addResource('items');
            
        // 1. Protected POST /items
        telemetryResource.addMethod('POST', new apigateway.LambdaIntegration(protectedTelemetryLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });
        
        // 2. Protected GET /items (fetches all for the authenticated user)
        telemetryResource.addMethod('GET', new apigateway.LambdaIntegration(protectedTelemetryLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });
        
        // 3. Public GET /items/{id}
        const telemetryIdResource = telemetryResource.addResource('{id}');
        telemetryIdResource.addMethod('GET', new apigateway.LambdaIntegration(publicTelemetryLambda)); // No authorizer attached

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
        NagSuppressions.addResourceSuppressions(publicTelemetryLambda, [
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
        NagSuppressions.addResourceSuppressions(protectedTelemetryLambda, [
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

        NagSuppressions.addResourceSuppressions(telemetryTable, [
            {
                id: 'AwsSolutions-DDB3',
                reason: 'Point-in-time recovery is not required for this sample application. In production, enable PITR for data protection.'
            }
        ], true);
        NagSuppressions.addResourceSuppressions(agentReporterLambda, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'CDK grantRead auto-generates wildcards for S3 bucket actions and objects.',
                appliesTo: [
                    'Action::s3:GetBucket*',
                    'Action::s3:GetObject*',
                    'Action::s3:List*',
                    'Resource::arn:aws:s3:::custom-memories-ai-coach-unity/*'
                ]
            }
        ], true);

        NagSuppressions.addResourceSuppressions(agentInvokerLambda, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Using AWS Lambda Basic Execution Role is acceptable for this sample application.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'CDK grantReadWrite auto-generates wildcards for S3 bucket actions and objects.',
                appliesTo: [
                    'Action::s3:GetBucket*',
                    'Action::s3:GetObject*',
                    'Action::s3:List*',
                    'Action::s3:Abort*',
                    'Action::s3:DeleteObject*',
                    'Resource::arn:aws:s3:::custom-memories-ai-coach-unity/*'
                ]
            }
        ], true);
    }
}
