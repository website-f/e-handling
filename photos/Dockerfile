# Candidate photo worker: Camoufox (stealth Firefox) for web image search + OpenCV face crop.
# Same install recipe as Agentic-AI's browser service (deploy/browser.Dockerfile).
FROM python:3.12-slim-trixie

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt /app/requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini fonts-dejavu-core fonts-liberation \
 && pip install -r /app/requirements.txt \
 && python -m playwright install-deps firefox \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app app \
 # Named volume mounts here; creating it owned by app makes the volume writable for uid 10001.
 && install -d -o 10001 -g 10001 /data/photos \
 # The worker (uid 10001) keeps its face models under /app/models.
 && chown 10001:10001 /app

USER app
# Bake the browser binary in so nothing downloads at run time.
RUN python -m camoufox fetch
# OpenCV Zoo face models (YuNet detector + SFace recognizer) for the multi-source consensus check.
RUN mkdir -p /app/models && python -c "import urllib.request as u; \
b = 'https://github.com/opencv/opencv_zoo/raw/main/models/'; \
u.urlretrieve(b + 'face_detection_yunet/face_detection_yunet_2023mar.onnx', '/app/models/face_detection_yunet_2023mar.onnx'); \
u.urlretrieve(b + 'face_recognition_sface/face_recognition_sface_2021dec.onnx', '/app/models/face_recognition_sface_2021dec.onnx')"
COPY --chown=app:app worker.py /app/
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "worker.py"]
