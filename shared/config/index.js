const REQUIRED_VARS = {
  'api-service': [
    'GOOGLE_CLOUD_PROJECT',
    'FIREBASE_SERVICE_ACCOUNT',
    'PUBSUB_RESUME_TOPIC',
    'PUBSUB_SALARY_TOPIC',
    'PUBSUB_CAREER_TOPIC',
  ],
  'resume-worker': [
    'GOOGLE_CLOUD_PROJECT',
    'PUBSUB_RESUME_SUBSCRIPTION',
    'RESUME_ENGINE_VERSION',
  ],
  'salary-worker': [
    'GOOGLE_CLOUD_PROJECT',
    'PUBSUB_SALARY_SUBSCRIPTION',
    'SALARY_ENGINE_VERSION',
  ],
  'career-worker': [
    'GOOGLE_CLOUD_PROJECT',
    'PUBSUB_CAREER_SUBSCRIPTION',
    'CAREER_ENGINE_VERSION',
  ],
  'notification-worker': [
    'GOOGLE_CLOUD_PROJECT',
    'PUBSUB_NOTIFICATION_SUBSCRIPTION',
  ],
};

export function loadConfig(serviceName) {
  const required = REQUIRED_VARS[serviceName] ?? [];
  const missing = required.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(
      `[Config] Missing required environment variables for ${serviceName}: ${missing.join(', ')}`
    );
  }

  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '8080', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    serviceName,

    pubsub: {
      resumeTopic: process.env.PUBSUB_RESUME_TOPIC,
      salaryTopic: process.env.PUBSUB_SALARY_TOPIC,
      careerTopic: process.env.PUBSUB_CAREER_TOPIC,
      notificationTopic: process.env.PUBSUB_NOTIFICATION_TOPIC,
      scoreTopic: process.env.PUBSUB_SCORE_UPDATED_TOPIC,
      resumeSubscription: process.env.PUBSUB_RESUME_SUBSCRIPTION,
      salarySubscription: process.env.PUBSUB_SALARY_SUBSCRIPTION,
      careerSubscription: process.env.PUBSUB_CAREER_SUBSCRIPTION,
      notificationSubscription: process.env.PUBSUB_NOTIFICATION_SUBSCRIPTION,
      maxDeliveryAttempts: parseInt(process.env.PUBSUB_MAX_DELIVERY_ATTEMPTS ?? '5', 10),
      ackDeadlineSeconds: parseInt(process.env.PUBSUB_ACK_DEADLINE ?? '60', 10),
    },

    engines: {
      resumeVersion: process.env.RESUME_ENGINE_VERSION ?? 'resume_score_v1.0',
      salaryVersion: process.env.SALARY_ENGINE_VERSION ?? 'salary_bench_v1.0',
      careerVersion: process.env.CAREER_ENGINE_VERSION ?? 'career_path_v1.0',
    },

    firestore: {
      databaseId: process.env.FIRESTORE_DATABASE_ID ?? '(default)',
    },

    security: {
      internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,
      allowedAudience: process.env.ALLOWED_AUDIENCE,
    },
  };
}
