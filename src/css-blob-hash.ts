import { rgbToOkLab } from './convert.mjs';

export function encode(pixelData: Uint8ClampedArray, width: number, height: number): number {
	// reference: https://github.com/Kalabasa/leanrada.com/blob/7b6739c7c30c66c771fcbc9e1dc8942e628c5024/main/scripts/update/lqip.mjs#L54-L75
	let { ll, aaa, bbb, values } = analyzeImage(pixelData, width, height);

	let ca = Math.round(values[0] * 0b11);
	let cb = Math.round(values[1] * 0b11);
	let cc = Math.round(values[2] * 0b11);
	let cd = Math.round(values[3] * 0b11);
	let ce = Math.round(values[4] * 0b11);
	let cf = Math.round(values[5] * 0b11);
	let lqip =
		-(2 ** 19) +
		((ca & 0b11) << 18) +
		((cb & 0b11) << 16) +
		((cc & 0b11) << 14) +
		((cd & 0b11) << 12) +
		((ce & 0b11) << 10) +
		((cf & 0b11) << 8) +
		((ll & 0b11) << 6) +
		((aaa & 0b111) << 3) +
		(bbb & 0b111);

	// invariant check (+-999999 is the max int range in css in major browsers)
	if (lqip < -999_999 || lqip > 999_999) {
		throw new Error(`Invalid lqip value: ${lqip}`);
	}

	return lqip;
}

type ImageAnalysis = {
	ll: number;
	aaa: number;
	bbb: number;
	values: number[];
};

function analyzeImage(pixelData: Uint8ClampedArray, width: number, height: number): ImageAnalysis {
	// Interpret the image as a 3x2 grid of cells, and calculate the average rgb value of each cell
	//
	// +---+---+---+
	// |   |   |   |
	// +---+---+---+
	// |   |   |   |
	// +---+---+---+
	let cellWidth = width / 3;
	let cellHeight = height / 2;

	// track the pixel values from each cell
	let cells = Array.from({ length: 6 }, () => ({ r: 0, g: 0, b: 0, count: 0 }));
	// track the pixel values from the whole image
	let total = { r: 0, g: 0, b: 0 };

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const cellIndex = getCellIndex(x, y, cellWidth, cellHeight);
			const pixelIndex = (y * width + x) * 3;

			cells[cellIndex].r += pixelData[pixelIndex];
			cells[cellIndex].g += pixelData[pixelIndex + 1];
			cells[cellIndex].b += pixelData[pixelIndex + 2];
			cells[cellIndex].count++;

			total.r += pixelData[pixelIndex];
			total.g += pixelData[pixelIndex + 1];
			total.b += pixelData[pixelIndex + 2];
		}
	}

	const {
		L: rawBaseL,
		a: rawBaseA,
		b: rawBaseB,
	} = rgbToOkLab({
		r: Math.round(total.r / (width * height)),
		g: Math.round(total.g / (width * height)),
		b: Math.round(total.b / (width * height)),
	});
	const { ll, aaa, bbb } = findOklabBits(rawBaseL, rawBaseA, rawBaseB);
	const { L: baseL, a: baseA, b: baseB } = bitsToLab(ll, aaa, bbb);
	const values = cells.map((cell) => {
		// We only need perceptual lightness for each cell
		let { L } = rgbToOkLab({ r: cell.r / cell.count, g: cell.g / cell.count, b: cell.b / cell.count });
		return clamp(0.5 + L - baseL, 0, 1);
	});

	return {
		ll,
		aaa,
		bbb,
		values,
	};
}

function getCellIndex(x: number, y: number, cellWidth: number, cellHeight: number): number {
	const col = Math.min(2, Math.floor(x / cellWidth));
	const row = Math.min(1, Math.floor(y / cellHeight));
	return row * 3 + col;
}

// Lovingly copied from https://github.com/Kalabasa/leanrada.com/blob/7b6739c7c30c66c771fcbc9e1dc8942e628c5024/main/scripts/update/lqip.mjs#L118-L159

// find the best bit configuration that would produce a color closest to target
function findOklabBits(targetL: number, targetA: number, targetB: number): { ll: number; aaa: number; bbb: number } {
	const targetChroma = Math.hypot(targetA, targetB);
	const scaledTargetA = scaleComponentForDiff(targetA, targetChroma);
	const scaledTargetB = scaleComponentForDiff(targetB, targetChroma);

	let bestBits = [0, 0, 0];
	let bestDifference = Infinity;

	for (let lli = 0; lli <= 0b11; lli++) {
		for (let aaai = 0; aaai <= 0b111; aaai++) {
			for (let bbbi = 0; bbbi <= 0b111; bbbi++) {
				const { L, a, b } = bitsToLab(lli, aaai, bbbi);
				const chroma = Math.hypot(a, b);
				const scaledA = scaleComponentForDiff(a, chroma);
				const scaledB = scaleComponentForDiff(b, chroma);

				const difference = Math.hypot(L - targetL, scaledA - scaledTargetA, scaledB - scaledTargetB);

				if (difference < bestDifference) {
					bestDifference = difference;
					bestBits = [lli, aaai, bbbi];
				}
			}
		}
	}

	return { ll: bestBits[0], aaa: bestBits[1], bbb: bestBits[2] };
}

// Scales a or b of Oklab to move away from the center
// so that euclidean comparison won't be biased to the center
function scaleComponentForDiff(x: number, chroma: number): number {
	return x / (1e-6 + Math.pow(chroma, 0.5));
}

function bitsToLab(ll: number, aaa: number, bbb: number): { L: number; a: number; b: number } {
	const L = (ll / 0b11) * 0.6 + 0.2;
	const a = (aaa / 0b1000) * 0.7 - 0.35;
	const b = ((bbb + 1) / 0b1000) * 0.7 - 0.35;
	return { L, a, b };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
