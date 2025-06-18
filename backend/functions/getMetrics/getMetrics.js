const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { LambdaClient, GetFunctionConfigurationCommand } = require('@aws-sdk/client-lambda');

// Initialize DynamoDB client for application tables
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
// Lambda pricing constants (us-east-1, 2025)
const FALLBACK_INVOCATION_COST = 0.0000002; // $0.20/million
const FALLBACK_DURATION_COST_PER_GB_SECOND = 0.00001667; // $0.00001667/GB-second

exports.handler = async (event) => {
  try {
    // Log event for debugging
    console.log('Event:', JSON.stringify(event));
    // Extract inputs
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    const functionNames = event.queryStringParameters?.functionNames?.split(',') || [];
    if (!functionNames.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing functionNames' }) };
    }
    const startTime = event.queryStringParameters?.startTime
      ? Math.floor(new Date(event.queryStringParameters.startTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 3600; // Default: last hour
    const endTime = event.queryStringParameters?.endTime
      ? Math.floor(new Date(event.queryStringParameters.endTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    let invocationCost, durationCostPerGBSecond;
    // Mock response for local testing
    if (process.env.IS_LOCAL) {
      invocationCost = FALLBACK_INVOCATION_COST;
      durationCostPerGBSecond = FALLBACK_DURATION_COST_PER_GB_SECOND;
      const metrics = functionNames.map((fn) => ({
        functionName: fn,
        latency: 300,
        errors: 5,
        invocations: 1000,
        coldStarts: 10,
        cost: 0.05,
      }));
      // Mock DynamoDB write for ProfilerMetrics
      console.log('Mock DynamoDB write:', { userId, metrics });
      return {
        statusCode: 200,
        body: JSON.stringify({ userId, metrics }),
      };
    }

    // Fetch user’s IAM role ARN and region from ProfilerUsers
    let roleArn, userRegion;
    try {
      const { Item } = await ddbClient.send(new GetItemCommand({
        TableName: 'ProfilerUsers',
        Key: { userId: { S: userId } },
      }));
      roleArn = Item?.roleArn?.S;
      userRegion = Item?.region?.S || process.env.AWS_REGION; // Fallback to application's region
    } catch (error) {
      console.error('DynamoDB GetItem error:', error);
      throw new Error('Failed to fetch user configuration');
    }
    if (!roleArn) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No IAM role configured' }) };
    }

    // Fetch region-specific pricing
    try {
      const { Item } = await ddbClient.send(new GetItemCommand({
        TableName: 'PricingConfig',
        Key: { region: { S: userRegion } },
      }));
      invocationCost = parseFloat(Item?.invocationCost?.S) || FALLBACK_INVOCATION_COST;
      durationCostPerGBSecond = parseFloat(Item?.durationCostPerGBSecond?.S) || FALLBACK_DURATION_COST_PER_GB_SECOND;
      if (isNaN(invocationCost) || isNaN(durationCostPerGBSecond)) {
        console.warn('Invalid pricing data, using fallbacks');
        invocationCost = FALLBACK_INVOCATION_COST;
        durationCostPerGBSecond = FALLBACK_DURATION_COST_PER_GB_SECOND;
      }
    } catch (error) {
      console.warn('PricingConfig error, using fallbacks:', error);
      invocationCost =FALLBACK_INVOCATION_COST;
      durationCostPerGBSecond = FALLBACK_DURATION_COST_PER_GB_SECOND;
    }

    // Assume user’s IAM role via STS
    const stsClient = new STSClient({ region: userRegion });
    const { Credentials } = await stsClient.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `ProfilerSession-${userId}`,
    }));
    const lambdaClient = new LambdaClient({
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      },
      region: userRegion,
    });
    const userCwClient = new CloudWatchClient({
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      },
      region: userRegion, // Use user’s region
    });
    const userLogsClient = new CloudWatchLogsClient({
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      },
      region: userRegion, // Use user’s region
    });

    // Fetch CloudWatch metrics
    const metricQueries = functionNames.flatMap((fn, i) => [
      {
        Id: `latency${i}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Duration',
            Dimensions: [{ Name: 'FunctionName', Value: fn }],
          },
          Period: 300,
          Stat: 'Average',
        },
      },
      {
        Id: `errors${i}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Dimensions: [{ Name: 'FunctionName', Value: fn }],
          },
          Period: 300,
          Stat: 'Sum',
        },
      },
      {
        Id: `invocations${i}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Invocations',
            Dimensions: [{ Name: 'FunctionName', Value: fn }],
          },
          Period: 300,
          Stat: 'Sum',
        },
      },
    ]);

    const metricData = await userCwClient.send(new GetMetricDataCommand({
      MetricDataQueries: metricQueries,
      StartTime: startTime,
      EndTime: endTime,
    }));

    // Fetch cold starts from CloudWatch Logs
    const metrics = await Promise.all(functionNames.map(async (fn, i) => {
      const logGroupName = `/aws/lambda/${fn}`;
      let coldStarts = 0;
      try {
        const logData = await userLogsClient.send(new FilterLogEventsCommand({
          LogGroupName: logGroupName,
          StartTime: startTime * 1000,
          EndTime: endTime * 1000,
          FilterPattern: 'REPORT RequestId: Duration: Init Duration',
        }));
        coldStarts = logData.events?.filter((e) => e.message.includes('Init Duration')).length || 0;
      } catch (error) {
        console.warn(`No logs for ${fn}:`, error.message);
      }

      // Extract metrics
      let memoryMB = 128; // Fallback value
      try {
        const { Configuration } = await lambdaClient.send(new GetFunctionConfigurationCommand({
          FunctionName: fn,
        }));
        memoryMB = Configuration.MemorySize || 128;
      } catch (error) {
        console.warn(`Failed to fetch memory for ${fn}, using fallback:`, error.message);
      }
      const memoryGB = memoryMB / 1024;
      
      const latency = metricData.MetricDataResults.find((r) => r.Id === `latency${i}`)?.Values[0] || 0;
      const errors = metricData.MetricDataResults.find((r) => r.Id === `errors${i}`)?.Values[0] || 0;
      const invocations = metricData.MetricDataResults.find((r) => r.Id === `invocations${i}`)?.Values[0] || 0;

      const durationSeconds = (latency / 1000) * invocations; // Total seconds
      const cost = (invocations * INVOCATION_COST) + (durationSeconds * memoryGB * DURATION_COST_PER_GB_SECOND);

      // Store in DynamoDB
      await ddbClient.send(new PutItemCommand({
        TableName: process.env.METRICS_TABLE,
        Item: {
          userId: { S: userId },
          timestamp: { N: Date.now().toString() },
          functionName: { S: fn },
          latency: { N: latency.toString() },
          errors: { N: errors.toString() },
          invocations: { N: invocations.toString() },
          coldStarts: { N: coldStarts.toString() },
          cost: { N: cost.toFixed(6) },
          memoryMB: { N: memoryMB.toString() },
        },
      }));

      return { functionName: fn, latency, errors, invocations, coldStarts, cost: parseFloat(cost.toFixed(6)), memoryMB };
    }));

    // Return response for dashboard
    return {
      statusCode: 200,
      body: JSON.stringify({ userId, metrics }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};