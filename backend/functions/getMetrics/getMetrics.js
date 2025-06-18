const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');

// Initialize clients (default region, overridden by STS credentials)
const cwClient = new CloudWatchClient({ region: 'us-east-1' });
const logsClient = new CloudWatchLogsClient({ region: 'us-east-1' });
const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const stsClient = new STSClient({ region: 'us-east-1' });

// Lambda pricing constants (us-east-1, 2025)
const INVOCATION_COST = 0.0000002; // $0.20/million
const DURATION_COST_PER_GB_SECOND = 0.00001667; // $0.00001667/GB-second

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

    // Mock response for local testing
    if (process.env.IS_LOCAL) {
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

    // Fetch user’s IAM role ARN from DynamoDB
    const { Item } = await ddbClient.send(new GetItemCommand({
      TableName: 'ProfilerUsers', // Assumes a table for user configs (create in SAM template)
      Key: { userId: { S: userId } },
    }));
    const roleArn = Item?.roleArn?.S;
    if (!roleArn) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No IAM role configured' }) };
    }

    // Assume user’s IAM role via STS
    const { Credentials } = await stsClient.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `ProfilerSession-${userId}`,
    }));
    const userCwClient = new CloudWatchClient({
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      },
    });
    const userLogsClient = new CloudWatchLogsClient({
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      },
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
      const latency = metricData.MetricDataResults.find((r) => r.Id === `latency${i}`)?.Values[0] || 0;
      const errors = metricData.MetricDataResults.find((r) => r.Id === `errors${i}`)?.Values[0] || 0;
      const invocations = metricData.MetricDataResults.find((r) => r.Id === `invocations${i}`)?.Values[0] || 0;

      // Assume 128MB memory for cost calculation (fetch actual memory post-MVP)
      const memoryGB = 128 / 1024; // 128MB in GB
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
        },
      }));

      return { functionName: fn, latency, errors, invocations, coldStarts, cost: parseFloat(cost.toFixed(6)) };
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