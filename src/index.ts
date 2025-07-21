import { env } from 'cloudflare:workers';
import { encode as encodeBlurhash } from 'blurhash';
import { encode as encodeCSSBlobHash } from './css-blob-hash';
import quantize from './quantize';

// Our goal is to compress the image into some ultra-compressed representation that can be used to display
// a placeholder image while the full image is loading.
//
// We don't necessairily want to perform this computation over the whole image, which might be quite large,
// but instead we can leverage the Cloudflare Images binding to get a much smaller image that we can use
// for our calculations

// How small should we resize the image? We want to capture the dominant colors of the image, so
// I've found that 30x30 is a decent size to work with. Uncompressed this is ~2.7kb of pixel data
const RESIZE_DIMENSION = 30;

type AspectRatio = 'square' | 'landscape' | 'portrait';
type AspectRatioInfo = {
	aspectRatio: AspectRatio;
	width: number;
	height: number;
};

// Unfortunately, when asking the Images API to resize an image with rbg(a) output, we do not receive the
// resized dimensions with the response, just an array of pixel values. As a workaround we can calculate
// the expected resized dimensions by using the image's original aspect ratio and orientation, so let's
// first get the info for the original image
async function getAspectRatio(image: ReadableStream): Promise<AspectRatioInfo> {
	let info = await env.IMAGES.info(image);

	if (info.format === 'image/svg+xml') {
		// We can't get size information for SVG images, so let's not support them
		throw new Error('SVG images are not supported');
	}

	// We've already checked that the format is not SVG, but typescript doesn't recognize that,
	// so we'll cast it manually.
	info = info as { format: string; fileSize: number; width: number; height: number };

	if (info.width > info.height) {
		return { aspectRatio: 'landscape', width: info.width, height: info.height };
	} else if (info.width < info.height) {
		return { aspectRatio: 'portrait', width: info.width, height: info.height };
	}
	return { aspectRatio: 'square', width: info.width, height: info.height };
}

function getResizedDimensions(
	aspectRatioInfo: AspectRatioInfo,
	resizeDimension: number,
	numPixels: number
): { width: number; height: number } {
	let { aspectRatio } = aspectRatioInfo;
	if (aspectRatio === 'landscape') {
		return { width: resizeDimension, height: numPixels / resizeDimension };
	} else if (aspectRatio === 'portrait') {
		return { width: numPixels / resizeDimension, height: resizeDimension };
	} else if (aspectRatio === 'square') {
		return { width: Math.sqrt(numPixels), height: Math.sqrt(numPixels) };
	}
	// This should never happen since we've covered all possible values of AspectRatio
	let _exhaustiveCheck: never = aspectRatio;
	throw new Error(`Unexpected aspect ratio: ${aspectRatio}`);
}

function quantizeWrapper(pixelData: Uint8Array, numColors: number): [number, number, number][] {
	let pixelDataArrays = [];
	for (let i = 0; i < pixelData.length; i += 3) {
		pixelDataArrays.push([pixelData[i], pixelData[i + 1], pixelData[i + 2]]);
	}

	let palette = quantize(pixelDataArrays, numColors);
	return palette.palette();
}

// In order to make our calculations as simple as possible, we'll have the Images binding resize the image
// to a single pixel, and then we'll just read the RGB values of that pixel.
async function getDominantColor(image: ReadableStream): Promise<string> {
	let rbgImage = await env.IMAGES.input(image).transform({ width: 1, height: 1, fit: 'cover' }).output({ format: 'rgb' });
	let rgbImageBuffer = await rbgImage.response().arrayBuffer();
	let pixelData = new Uint8Array(rgbImageBuffer);

	let r = pixelData[0];
	let g = pixelData[1];
	let b = pixelData[2];

	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

async function getDominantColorFromPalette(image: ReadableStream): Promise<string> {
	let rbgImage = await env.IMAGES.input(image).transform({ width: 100, height: 100, fit: 'cover' }).output({ format: 'rgb' });
	let rgbImageBuffer = await rbgImage.response().arrayBuffer();
	let pixelData = new Uint8Array(rgbImageBuffer);

	let palette = quantizeWrapper(pixelData, 5);
	let dominantColor = palette[0];
	let r = dominantColor[0];
	let g = dominantColor[1];
	let b = dominantColor[2];

	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

async function getBlurhash(image: ReadableStream, aspectRatioInfo: AspectRatioInfo): Promise<string> {
	let resizedImage = await env.IMAGES.input(image)
		.transform({ width: RESIZE_DIMENSION, height: RESIZE_DIMENSION, fit: 'contain' })
		.output({ format: 'rgba' });
	let resizedImageBuffer = await resizedImage.response().arrayBuffer();
	let pixelDataClamped = new Uint8ClampedArray(resizedImageBuffer);

	let { width: resizedWidth, height: resizedHeight } = getResizedDimensions(aspectRatioInfo, RESIZE_DIMENSION, pixelDataClamped.length / 4);
	return encodeBlurhash(pixelDataClamped, resizedWidth, resizedHeight, 4, 4);
}

async function getCSSBlobHash(image: ReadableStream): Promise<number> {
	let resizedImage = await env.IMAGES.input(image).transform({ width: 3, height: 2, fit: 'squeeze' }).output({ format: 'rgb' });
	let resizedImageBuffer = await resizedImage.response().arrayBuffer();
	let pixelDataClamped = new Uint8ClampedArray(resizedImageBuffer);

	return encodeCSSBlobHash(pixelDataClamped);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		let url = new URL(request.url);
		let pathname = url.pathname;

		if (pathname.startsWith('/api/')) {
			// If this is an API request (has 'url' query parameter), process the image
			const imageUrl = url.searchParams.get('url');
			if (!imageUrl) {
				return new Response('Missing url query parameter', { status: 400 });
			}

			let imageResponse = await fetch(imageUrl);
			if (!imageResponse.body) {
				return new Response('Failed to fetch image', { status: 400 });
			}

			// Reading the body stream consumes it, so let's tee it to make copies
			// There is likely a better way to do this that I'm missing
			let [bodyCopy, extra] = imageResponse.body.tee();
			let [bodyCopy2, extra2] = extra.tee();
			let [bodyCopy3, extra3] = extra2.tee();
			let [bodyCopy4, extra4] = extra3.tee();
			let [bodyCopy5, extra5] = extra4.tee();

			let aspectRatioInfo = await getAspectRatio(bodyCopy);
			let dominantColor = await getDominantColor(bodyCopy2);
			let dominantColorFromPalette = await getDominantColorFromPalette(bodyCopy3);
			let blurhash = await getBlurhash(bodyCopy4, aspectRatioInfo);
			let cssBlobHash = await getCSSBlobHash(bodyCopy5);

			return new Response(
				JSON.stringify(
					{
						aspectRatio: aspectRatioInfo.aspectRatio,
						width: aspectRatioInfo.width,
						height: aspectRatioInfo.height,
						dominantColor,
						dominantColorFromPalette,
						blurhash,
						cssBlobHash,
					},
					null,
					2
				),
				{
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Otherwise, serve static assets
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
