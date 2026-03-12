import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,

  formatters: {
    level: (label) => ({ level: label }),
  },

  base: {
    service: 'interview-room-ai',
    env: process.env.NODE_ENV,
  },

  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'hashedPassword',
      'apiKey',
      'ANTHROPIC_API_KEY',
      // PII fields
      'email',
      'candidateEmail',
      'resumeText',
      'jobDescription',
      'stripeCustomerId',
      // Nested PII in error/request objects
      '*.email',
      '*.candidateEmail',
      '*.resumeText',
      '*.jobDescription',
      '*.stripeCustomerId',
    ],
    censor: '[REDACTED]',
  },
})

export const dbLogger = logger.child({ module: 'database' })
export const authLogger = logger.child({ module: 'auth' })
export const aiLogger = logger.child({ module: 'ai-api' })
