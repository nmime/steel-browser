import { z } from "zod";

const FileUploadRequest = z.object({
  file: z.any().describe("The file to upload (binary) or URL string to download from"),
  path: z.string().optional().describe("Path to the file in the storage system"),
});

const FileDetails = z.object({
  path: z.string().describe("Path to the file in the storage system"),
  size: z.number().describe("Size of the file in bytes"),
  lastModified: z.string().datetime().describe("Timestamp when the file was last updated"),
});

const MultipleFiles = z.object({
  data: z.array(FileDetails).describe("Array of files for the current page"),
});

const SignedFileUrlRequest = z.object({
  path: z.string().describe("Path to the file in the storage system"),
  operation: z.enum(["read", "write"]).describe("Signed URL operation"),
  expiresInSeconds: z.number().int().min(1).max(86_400).optional(),
  contentType: z.string().optional().describe("Content-Type for write URLs"),
});

const SignedFileUrl = z.object({
  url: z.string().url().describe("Signed URL"),
  method: z.enum(["GET", "PUT", "POST"]).describe("HTTP method to use with the signed URL"),
  expiresAt: z.string().datetime().describe("Expiration timestamp"),
  headers: z.record(z.string()).optional().describe("Headers to include when using the signed URL"),
});

export type FileDetails = z.infer<typeof FileDetails>;
export type MultipleFiles = z.infer<typeof MultipleFiles>;
export type FileUploadRequest = z.infer<typeof FileUploadRequest>;
export type SignedFileUrlRequest = z.infer<typeof SignedFileUrlRequest>;
export type SignedFileUrl = z.infer<typeof SignedFileUrl>;

export const filesSchemas = {
  FileUploadRequest,
  FileDetails,
  MultipleFiles,
  SignedFileUrlRequest,
  SignedFileUrl,
};

export default filesSchemas;
