import axios from 'axios';

export interface IgLoginPayload {
  username: string;
  password: string;
  verification_code?: string;
  proxy_config?: any;
}

export interface IgLoginResponse {
  success: boolean;
  settings?: any;
  detail?: string;
}

export interface IgUploadPhotoPayload {
  settings_json: any;
  photo_path: string;
  caption?: string;
  proxy_config?: any;
}

export interface IgUploadVideoPayload {
  settings_json: any;
  video_path: string;
  caption?: string;
  proxy_config?: any;
}

export interface IgUploadResponse {
  success: boolean;
  media_pk?: string;
  media_id?: string;
  detail?: string;
}

export class InstagrapiClient {
  constructor(private baseUrl: string = process.env.IG_API_URL || 'http://127.0.0.1:8081') {}

  async login(payload: IgLoginPayload): Promise<IgLoginResponse> {
    try {
      const { data } = await axios.post(`${this.baseUrl}/login`, payload, { timeout: 20000 });
      return data as IgLoginResponse;
    } catch (e: any) {
      return { success: false, detail: e?.response?.data?.detail || e?.message };
    }
  }

  async uploadPhoto(payload: IgUploadPhotoPayload): Promise<IgUploadResponse> {
    try {
      const { data } = await axios.post(`${this.baseUrl}/upload_photo`, payload, { timeout: 60000 });
      return data as IgUploadResponse;
    } catch (e: any) {
      return { success: false, detail: e?.response?.data?.detail || e?.message };
    }
  }

  async uploadVideo(payload: IgUploadVideoPayload): Promise<IgUploadResponse> {
    try {
      const { data } = await axios.post(`${this.baseUrl}/upload_video`, payload, { timeout: 120000 });
      return data as IgUploadResponse;
    } catch (e: any) {
      return { success: false, detail: e?.response?.data?.detail || e?.message };
    }
  }
}


