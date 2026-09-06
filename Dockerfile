FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

# The SQLite file lives on a volume so deploys don't wipe the price history.
ENV FLIGHTTRACKER_DB=/data/prices.db
VOLUME /data

EXPOSE 5010

CMD ["gunicorn", "--bind", "0.0.0.0:5010", "--workers", "1", "--threads", "24", \
     "--timeout", "120", "flighttracker.web:app"]
