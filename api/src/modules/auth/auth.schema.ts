import { z } from "zod";
import type { FastifyRequest } from "fastify";

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const CreateApiKeySchema = z.object({
  name: z.string().optional(),
  subject: z.string().min(1),
  roles: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  tenantId: z.string().optional(),
  orgId: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type LoginRequest = FastifyRequest<{ Body: z.infer<typeof LoginSchema> }>;
export type CreateApiKeyRequest = FastifyRequest<{ Body: z.infer<typeof CreateApiKeySchema> }>;

export default { Login: LoginSchema, CreateApiKey: CreateApiKeySchema };
