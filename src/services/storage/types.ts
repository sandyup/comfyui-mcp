export interface S3Auth {
  type: "s3";
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  region?: string;
  endpoint?: string;
}

export interface CloudStorageAuth {
  s3?: S3Auth;
}

export interface StorageUploadSource {
  path?: string;
  data?: Buffer;
  filename: string;
  contentType?: string;
}

export interface StorageUploadResult {
  provider: "s3" | "azure" | "http" | "hf";
  url: string;
}

