import { z } from 'zod';
import {
  GLOBAL_MAX_BODY_BYTES,
  readJsonBody,
  type RequestBodyErrorCode,
} from './request-body';

const MAX_TEXT_CHARS = 16 * 1024;
const MAX_YAML_CHARS = 128 * 1024;
const MAX_ERRORS = 256;
const MAX_ERROR_PATH_CHARS = 2 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 4 * 1024;

const RequiredTextSchema = z.string().trim().min(1).max(MAX_TEXT_CHARS);
const YamlSchema = z
  .string()
  .max(MAX_YAML_CHARS)
  .refine((value) => value.trim().length > 0);
const OptionalNameSchema = z.string().trim().min(1).max(253).nullable().optional();
const OptionalTextSchema = z.string().max(MAX_TEXT_CHARS).optional();
const OptionalPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ERROR_PATH_CHARS)
  .nullable()
  .optional();

const ValidationErrorSchema = z.strictObject({
  path: z.string().max(MAX_ERROR_PATH_CHARS),
  message: z.string().trim().min(1).max(MAX_ERROR_MESSAGE_CHARS),
});

const ValidationErrorsSchema = z
  .array(ValidationErrorSchema)
  .max(MAX_ERRORS);

const EditorContextSchema = z.strictObject({
  yaml: z.string().max(MAX_YAML_CHARS).optional(),
  kind: OptionalNameSchema,
  apiVersion: OptionalNameSchema,
  selectedText: OptionalTextSchema,
  cursorPath: OptionalPathSchema,
  errors: ValidationErrorsSchema.optional(),
});

const AskRequestSchema = z.strictObject({
  question: RequiredTextSchema,
  mode: z.enum(['free', 'explain_field', 'explain_error']).default('free'),
  context: EditorContextSchema.optional(),
});

const CheckRequestSchema = z.strictObject({
  yaml: YamlSchema,
});

const GenerateRequestSchema = z.strictObject({
  requirement: RequiredTextSchema,
});

const FixRequestSchema = z.strictObject({
  yaml: YamlSchema,
  errors: ValidationErrorsSchema.default([]),
});

const ApiRequestSchemas = {
  ask: AskRequestSchema,
  check: CheckRequestSchema,
  generate: GenerateRequestSchema,
  fix: FixRequestSchema,
} as const;

type ApiRoute = keyof typeof ApiRequestSchemas;

interface ApiRequestMap {
  ask: z.infer<typeof AskRequestSchema>;
  check: z.infer<typeof CheckRequestSchema>;
  generate: z.infer<typeof GenerateRequestSchema>;
  fix: z.infer<typeof FixRequestSchema>;
}

const API_BODY_LIMITS = {
  ask: GLOBAL_MAX_BODY_BYTES,
  check: 144 * 1024,
  generate: 72 * 1024,
  fix: GLOBAL_MAX_BODY_BYTES,
} as const satisfies Record<ApiRoute, number>;

type ApiRequestDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'invalid_request' };

function decodeApiRequest<R extends ApiRoute>(
  route: R,
  input: unknown,
): ApiRequestDecodeResult<ApiRequestMap[R]> {
  const result = ApiRequestSchemas[route].safeParse(input);
  if (!result.success) return { ok: false, code: 'invalid_request' };
  return { ok: true, value: result.data as ApiRequestMap[R] };
}

type ApiRequestReadResult<R extends ApiRoute> =
  | { ok: true; value: ApiRequestMap[R] }
  | { ok: false; response: Response };

function requestErrorResponse(
  code: RequestBodyErrorCode | 'invalid_request',
): Response {
  return Response.json(
    { error: { code } },
    {
      status: code === 'payload_too_large' ? 413 : 400,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

export async function readApiRequest<R extends ApiRoute>(
  request: Request,
  route: R,
): Promise<ApiRequestReadResult<R>> {
  const body = await readJsonBody(request, API_BODY_LIMITS[route]);
  if (!body.ok) {
    return { ok: false, response: requestErrorResponse(body.code) };
  }
  const decoded = decodeApiRequest(route, body.value);
  if (!decoded.ok) {
    return { ok: false, response: requestErrorResponse(decoded.code) };
  }
  return decoded;
}
