import os
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException
from instagrapi import Client
from pydantic import BaseModel

app = FastAPI()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET")


class LoginRequest(BaseModel):
    username: str
    password: str
    verification_code: Optional[str] = None
    proxy_config: Optional[dict] = None


class UploadPhotoRequest(BaseModel):
    settings_json: dict
    caption: Optional[str] = None
    photo_path: str
    proxy_config: Optional[dict] = None


class UploadVideoRequest(BaseModel):
    settings_json: dict
    caption: Optional[str] = None
    video_path: str
    proxy_config: Optional[dict] = None


class StatsRequest(BaseModel):
    settings_json: dict
    username: str
    proxy_config: Optional[dict] = None


def configure_proxy(client: Client, proxy_config: Optional[dict]):
    """Configure proxy for instagrapi client"""
    if not proxy_config:
        return
    
    try:
        # Extract proxy details
        host = proxy_config.get('host')
        port = proxy_config.get('port')
        username = proxy_config.get('username')
        password = proxy_config.get('password')
        protocol = proxy_config.get('protocol', 'http')
        
        if not host or not port:
            return
        
        # Build proxy URL
        proxy_url = f"{protocol}://"
        if username and password:
            proxy_url += f"{username}:{password}@"
        proxy_url += f"{host}:{port}"
        
        # Configure proxy for instagrapi
        client.set_proxy(proxy_url)
        print(f"Proxy configured: {protocol}://{host}:{port}")
        
    except Exception as e:
        print(f"Failed to configure proxy: {e}")


@app.post("/get_stats")
def get_stats(req: StatsRequest):
    cl = Client()
    try:
        # Configure proxy if provided
        configure_proxy(cl, req.proxy_config)
        
        cl.set_settings(req.settings_json)
        cl.get_timeline_feed()  # warm up session
        
        # Get user info using instagrapi's API
        user_info = cl.user_info_by_username(req.username)
        
        # Get user's recent media
        user_id = user_info.pk
        medias = cl.user_medias(user_id, amount=30)  # Get last 30 posts
        
        # Calculate engagement metrics
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        week_ago = now - timedelta(days=7)
        month_ago = now - timedelta(days=30)
        
        engagement_7d = 0
        engagement_30d = 0
        posts_7d = 0
        posts_30d = 0
        
        for media in medias:
            taken_at = media.taken_at
            likes = media.like_count or 0
            comments = media.comment_count or 0
            total_engagement = likes + comments
            
            # Ensure taken_at is timezone-aware for comparison
            if taken_at.tzinfo is None:
                taken_at = taken_at.replace(tzinfo=timezone.utc)
            
            if taken_at >= week_ago:
                engagement_7d += total_engagement
                posts_7d += 1
            
            if taken_at >= month_ago:
                engagement_30d += total_engagement
                posts_30d += 1
        
        return {
            "success": True,
            "username": user_info.username,
            "followers": user_info.follower_count,
            "engagement_7d": engagement_7d,
            "engagement_30d": engagement_30d,
            "posts_7d": posts_7d,
            "posts_30d": posts_30d
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/login")
def login(req: LoginRequest):
    cl = Client()
    try:
        # Configure proxy if provided
        configure_proxy(cl, req.proxy_config)
        
        cl.login(req.username, req.password, verification_code=req.verification_code)
        settings = cl.get_settings()
        return {"success": True, "settings": settings}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/upload_photo")
def upload_photo(req: UploadPhotoRequest):
    cl = Client()
    try:
        # Configure proxy if provided
        configure_proxy(cl, req.proxy_config)
        
        cl.set_settings(req.settings_json)
        cl.get_timeline_feed()  # warm up session
        
        photo_path = ensure_media_path(req.photo_path)
        if not os.path.exists(photo_path):
            raise HTTPException(status_code=404, detail=f"Photo file not found: {req.photo_path}")
            
        media = cl.photo_upload(photo_path, req.caption or "")
        return {"success": True, "media_pk": media.pk, "media_id": media.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/upload_video")
def upload_video(req: UploadVideoRequest):
    cl = Client()
    try:
        # Configure proxy if provided
        configure_proxy(cl, req.proxy_config)
        
        cl.set_settings(req.settings_json)
        cl.get_timeline_feed()  # warm up session
        
        video_path = ensure_media_path(req.video_path)
        if not os.path.exists(video_path):
            raise HTTPException(status_code=404, detail=f"Video file not found: {req.video_path}")
            
        media = cl.video_upload(video_path, req.caption or "")
        return {"success": True, "media_pk": media.pk, "media_id": media.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def ensure_media_path(original_path: str) -> str:
    target_path = original_path if os.path.isabs(original_path) else os.path.abspath(original_path)
    if os.path.exists(target_path):
        return target_path

    if not (SUPABASE_URL and SUPABASE_KEY and SUPABASE_BUCKET):
        return target_path

    rel_key = os.path.relpath(target_path, os.getcwd()).replace("\\", "/")
    if rel_key.startswith(".."):
        rel_key = original_path.lstrip("./")

    try:
        response = requests.get(
            f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{rel_key}",
            headers={
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Apikey": SUPABASE_KEY,
            },
            timeout=30,
        )
        if response.status_code >= 400:
            raise HTTPException(status_code=404, detail=f"Media not found in storage: {original_path}")

        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        with open(target_path, "wb") as fh:
            fh.write(response.content)
        return target_path
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch media from storage: {exc}") from exc

