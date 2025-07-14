# Low Quality Image Placeholders on Cloudflare Workers

This demo repo contains a couple of implementations for generating
ultra-compressed versions of images that can be sent along with either
the HTML or an API request that a browser or app can display to the user
before the full image has been downloaded.

## Using Cloudflare Image bindings

[Others have written about this before](https://taybenlor.substack.com/p/blurhash-as-a-service-with-cloudflare)
but bringing in a whole PNG library and processing it all in pure JavaScript felt a little
heavy. Other approaches involved using wasm modules to read the image data which also felt too heavy.

I approached it differently using [Cloudflare Images](https://developers.cloudflare.com/images/) which
can leverage optimized battle-tested native code.

In order to calculate these approximations, you want access to the raw pixel values. While not
highlighted in the documentation, the images binding [can output a raw array of RGB or RBGA pixels](https://workers-types.pages.dev/#ImageOutputOptions).
Since we are looking for a highly-compressed representation, we also resize the image to fit within
30 x 30 pixels to make calculation quick and easy.

Before discovering that we could get raw pixel values from Cloudflare Bindings I did go down a
path building an ultra-simple TypeScript PNG decoder. If you're interested in that [I've left it in the repo](src/parse-png.ts).

## LQIP implementations

There are three different implementations here:

### Dominant color from an image

The simplest option. Pick a single color for the image, and set the `background-color`
to that color while the image is loading. This is the approach used by Pinterest, among
others.

This is easy to implement on both the client and server, doesn't require any JavaScript
to load, but the solid block of color can be a bit visually underwhelming compared to the
alternatives.

### Blurhash

https://blurha.sh/ is a clever approach that compresses an image into blurry gradients
and packs that data into a small string like `LEHV6nWB2yk8pyo0adR*.7kCMdnj`. The [TypeScript
library](https://github.com/woltapp/blurhash/tree/master/TypeScript) works great on Workers.

Blurhash provides a really visually pleasing output, but does require JavaScript and the Canvas
API to render the placeholder, which may not be the best solution for all use-cases.

### CSS-only blobhash

[Lean Rada](https://leanrada.com/) recently posted about an even-more-clever CSS-only solution
[on their blog](https://leanrada.com/notes/css-only-lqip/).

This combines the other two approaches by getting the dominant color, but also breaking the image
into 6 different parts and extracting the relative brightness of each. This is all bit-packed into
a single number between `-999,999` and `999,999` in a way that can be extracted by modern CSS.

It seems the only implementation of this so far is [their blog itself](https://github.com/Kalabasa/leanrada.com/blob/7b6739c7c30c66c771fcbc9e1dc8942e628c5024/main/scripts/update/lqip.mjs#L54-L75). I've modified it
somewhat to work well on Workers.
