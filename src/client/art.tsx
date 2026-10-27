import art0 from './design/art/study-return.jpg';
import art1 from './design/art/study-inquiry.jpg';
import art2 from './design/art/study-perspective.jpg';
import art3 from './design/art/study-stillness.jpg';
import art4 from './design/art/study-possibility.jpg';
import art5 from './design/art/study-tension.jpg';
import art6 from './design/art/position-situation.png';
import art7 from './design/art/position-tension.png';
import art8 from './design/art/position-possibility.png';
import art9 from './design/art/hero-rose.webp';
import art10 from './design/art/progress-strip.png';
import art11 from './design/art/leaves.png';

const art = {
  'study-return': art0,
  'study-inquiry': art1,
  'study-perspective': art2,
  'study-stillness': art3,
  'study-possibility': art4,
  'study-tension': art5,
  'position-situation': art6,
  'position-tension': art7,
  'position-possibility': art8,
  'hero-rose': art9,
  'progress-strip': art10,
  leaves: art11,
} as const;
export type ArtName = keyof typeof art;
export function Art({ name, className = '' }: { name: ArtName; className?: string }) {
  return <img className={`art ${className}`} src={art[name]} alt="" aria-hidden="true" />;
}

const studies = [
  'study-return',
  'study-inquiry',
  'study-perspective',
  'study-stillness',
  'study-possibility',
  'study-tension',
] as const;
export function historyArt(id: string): ArtName {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return studies[hash % studies.length]!;
}
