import art0 from './design/art/study-return.jpg';
import art1 from './design/art/study-inquiry.jpg';
import art2 from './design/art/study-perspective.jpg';
import art3 from './design/art/study-stillness.jpg';
import art4 from './design/art/study-possibility.jpg';
import art5 from './design/art/study-tension.jpg';
import art11 from './design/art/leaves.png';
import manifest from './design/art/optimized/manifest.json';

type ImageSpec = { src: string; width: number; height: number; srcSet?: string; sizes?: string };
const variants = import.meta.glob<string>('./design/art/optimized/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});
const plate = (src: string, width: number, height: number): ImageSpec => ({ src, width, height });
function responsive(name: keyof typeof manifest, sizes: string): ImageSpec {
  const image = manifest[name];
  const url = (file: string) => variants[`./design/art/optimized/${file}`]!;
  return {
    src: url(image.variants[1]!.file),
    width: image.width,
    height: image.height,
    srcSet: image.variants.map((variant) => `${url(variant.file)} ${variant.width}w`).join(', '),
    sizes,
  };
}

const art = {
  'study-return': plate(art0, 487, 450),
  'study-inquiry': plate(art1, 488, 434),
  'study-perspective': plate(art2, 488, 450),
  'study-stillness': plate(art3, 488, 450),
  'study-possibility': plate(art4, 488, 434),
  'study-tension': plate(art5, 487, 434),
  leaves: plate(art11, 374, 188),
  'spread-ribbon': responsive('spread-ribbon', '(max-width: 1080px) 44vw, 480px'),
  'account-sprig': responsive('account-sprig', '(max-width: 760px) 72px, 280px'),
  'three-card-spread': responsive('three-card-spread', '(max-width: 760px) 220px, 320px'),
  'mobile-corner': responsive('mobile-corner', '72px'),
} as const;
export type ArtName = keyof typeof art;
export function Art({
  name,
  className = '',
  mobileName,
  mobileAt = 760,
  sizes,
  loading = 'eager',
}: {
  name: ArtName;
  className?: string;
  mobileName?: ArtName;
  mobileAt?: number;
  sizes?: string;
  loading?: 'eager' | 'lazy';
}) {
  const image = art[name];
  const mobile = mobileName ? art[mobileName] : null;
  // A compact fallback avoids WebKit speculatively requesting the desktop image
  // while React mounts the picture/source tree. Desktop is the qualified source.
  const fallback = mobile ?? image;
  const img = (
    <img
      className={`art ${mobile ? '' : className}`}
      src={fallback.src}
      srcSet={fallback.srcSet}
      sizes={mobile ? mobile.sizes : (sizes ?? image.sizes)}
      width={fallback.width}
      height={fallback.height}
      alt=""
      aria-hidden="true"
      decoding="async"
      loading={loading}
    />
  );
  return mobile ? (
    <picture className={`art-picture ${className}`}>
      <source
        media={`(min-width: ${mobileAt + 1}px)`}
        srcSet={image.srcSet ?? image.src}
        sizes={sizes ?? image.sizes}
        width={image.width}
        height={image.height}
      />
      {img}
    </picture>
  ) : (
    img
  );
}
