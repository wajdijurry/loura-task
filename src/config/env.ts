import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Empty string is treated as unset so `.env.example` can document the key.
  WORKER_ID: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined)),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  JOB_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(15_000),
  MAX_CLASSIFICATION_ATTEMPTS: z.coerce.number().int().positive().default(3),
  FAKE_MODEL_LATENCY_MS: z.coerce.number().int().nonnegative().default(200),
  CLASSIFIER_VERSION: z.string().min(1).default('fake-v1'),
  PROMPT_VERSION: z.string().min(1).default('v1'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  workerId: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const data = parsed.data;
  if (data.MODEL_TIMEOUT_MS >= data.JOB_LEASE_MS) {
    throw new Error(
      `MODEL_TIMEOUT_MS (${data.MODEL_TIMEOUT_MS}) must be less than JOB_LEASE_MS (${data.JOB_LEASE_MS})`,
    );
  }

  return {
    ...data,
    workerId: data.WORKER_ID ?? `worker-${randomUUID()}`,
  };
}
