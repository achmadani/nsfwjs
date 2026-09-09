// NSFWJS downloads its model on first load when NSFW_MODEL_PATH is not set.
// This script intentionally does not download model weights during npm install.
// For air-gapped production, place the model directory in models/ and set
// NSFW_MODEL_PATH=models before starting PM2.
console.log('Model preparation is configuration-based. Set NSFW_MODEL_PATH to a local NSFWJS model directory for production.');
