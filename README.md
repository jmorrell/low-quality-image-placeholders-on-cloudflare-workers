# Low Quality Image Placeholders on Cloudflare Workers

<img width="1213" height="1268" alt="The demo application showing several different types of LQIP images" src="https://github.com/user-attachments/assets/2123b6fc-2690-4af6-a2b3-b5c29513adfb" />


This demo repo contains a couple of implementations for generating
ultra-compressed versions of images that can be sent along with either
the HTML or an API request that a browser or app can display to the user
before the full image has been downloaded.

There is a demo app included to experiment with this locally that can be run by:

```bash
npm install
npm run dev
```

## Using Cloudflare Image bindings

[Others have written about this before](https://taybenlor.substack.com/p/blurhash-as-a-service-with-cloudflare)
but bringing in a whole PNG library and processing it all in pure JavaScript felt a little
heavy. Other approaches involved using wasm modules to read the image data which also felt too heavy.

I approached it differently using [Cloudflare Images](https://developers.cloudflare.com/images/) which
can leverage optimized battle-tested native code and is available with a few lines of wrangler config.

In order to calculate these approximations, you want access to the raw pixel values. While not
highlighted in the documentation, the images binding [can output a raw array of RGB or RBGA pixels](https://workers-types.pages.dev/#ImageOutputOptions).
Since we are looking for a highly-compressed representation, we also resize the image to fit within
30 x 30 pixels to make calculation quick and easy.

Before discovering that we could get raw pixel values from Cloudflare Bindings I started down a
path building an ultra-simple TypeScript PNG decoder. If you're interested in that [I've left it in the repo](src/parse-png.ts).

## LQIP implementations

### Dominant color from an image

The simplest option. Pick a single color for the image, and set the `background-color`
to that color while the image is loading. This is the approach used by Pinterest, among
others.

This is easy to implement on both the client and server, doesn't require any JavaScript
to load, but the solid block of color can be a bit visually underwhelming compared to the
alternatives.

I've implemented this two ways. The simpler method is just resizing the image down to
a single 1x1 pixel and taking that value. This requires very little code and works
reasonably well for photos, however it can blend together colors from the image
and wind up looking a bit muddy.

The second approach resizes the image to be reasonable to work with, and then uses the
[underlying Modified Median Cut Quantization (MMCQ) algorithm](https://github.com/lokesh/quantize) from
the [color-thief](https://github.com/lokesh/color-thief) library to group colors together. If
the image has a lot of a single color, such as text on a white background, it will tend to pick out
this main color instead of averaging it with the rest of the colors in the image.

![pinterest-placeholders](https://github.com/user-attachments/assets/960a3d30-ce27-4443-bd11-4ad30daaeff8)

### Blurhash

https://blurha.sh/ is a clever approach that compresses an image into blurry gradients
and packs that data into a small string like `LEHV6nWB2yk8pyo0adR*.7kCMdnj`. The [TypeScript
library](https://github.com/woltapp/blurhash/tree/master/TypeScript) works great on Workers.

Blurhash provides a really visually pleasing output, but does require JavaScript and the Canvas
API to render the placeholder, which may not be the best solution for all use-cases.

<img width="1230" height="484" alt="Screenshot of Blurhash website showing an example of a compressed image" src="https://github.com/user-attachments/assets/00ffbc33-38fd-4fd3-a387-6c332acef868" />

### CSS-only blobhash

[Lean Rada](https://leanrada.com/) recently posted about an even-more-clever CSS-only solution
[on their blog](https://leanrada.com/notes/css-only-lqip/).

This combines the other two approaches by getting the dominant color, but also breaking the image
into 6 different parts and extracting the relative brightness of each. This is all bit-packed into
a single number between `-999,999` and `999,999` in a way that can be extracted by modern CSS.

It seems the only implementation of this so far is [their blog itself](https://github.com/Kalabasa/leanrada.com/blob/7b6739c7c30c66c771fcbc9e1dc8942e628c5024/main/scripts/update/lqip.mjs#L54-L75). I've modified it
somewhat to work well on Workers.

There is another feature of the Cloudflare Images bindings that is not documented that helps with this logic. There
is a ["squeeze" fit](https://workers-types.pages.dev/#BasicImageTransformations.fit) that "Stretches and deforms to
the width and height given, even if it breaks aspect ratio" which allows us to resize to exactly 3x2 pixels.

<img width="1038" height="835" alt="Comparison of CSS-only hash vs blurhash" src="https://github.com/user-attachments/assets/66c715a4-61a7-4d27-80a4-04be324c5cdb" />

### Thumbhash

[Evan Wallace](https://madebyevan.com/) built an alternative to Blurhash called [Thumbhash](https://evanw.github.io/thumbhash/)
with a couple of advantages:

- more compact
- encodes the aspect ratio and average color
- alpha transparency support

It's used very similarly to Blurhash, requiring Javascript and a Canvas API to render the placeholder.
