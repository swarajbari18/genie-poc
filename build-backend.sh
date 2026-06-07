#!/bin/bash
set -e

REGISTRY="europe-west2-docker.pkg.dev/genie-poc-497306/genie-backend"
BASE_IMAGE="${REGISTRY}/base:1"
TAG=$(git rev-parse --short HEAD)
IMAGE="${REGISTRY}/backend:${TAG}"

echo "Building image: ${IMAGE}"

docker build \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  -t "${IMAGE}" \
  ./backend

docker push "${IMAGE}"

echo "${IMAGE}" > .backend-image
echo "Pushed: ${IMAGE}"
