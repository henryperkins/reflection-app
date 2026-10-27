import { Art, type ArtName } from './art.tsx';

const suits: Record<string, { label: string; art: ArtName }> = {
  major: { label: 'Major Arcana', art: 'study-perspective' },
  cups: { label: 'Cups', art: 'study-stillness' },
  pentacles: { label: 'Pentacles', art: 'study-possibility' },
  wands: { label: 'Wands', art: 'study-tension' },
  swords: { label: 'Swords', art: 'study-return' },
};
function cardArt(cardId: string) {
  const prefix = cardId.split('-')[0]!;
  const suit = Object.hasOwn(suits, prefix) ? prefix : 'major';
  return { suit, ...suits[suit]! };
}
export function CardFace({
  cardId,
  orientation,
  name,
}: {
  cardId: string;
  orientation: 'upright' | 'reversed';
  name: string | undefined;
}) {
  const { suit, label, art } = cardArt(cardId);
  return (
    <div className={`card-face suit-${suit}`} aria-hidden="true">
      <div className="card-face-inner">
        <div className={`card-face-art ${orientation}`}>
          <Art name={art} />
        </div>
        <div className="card-face-caption">
          <span className="caption">{label}</span>
          <span className="card-face-name">{name ?? cardId}</span>
          <span className="caption orientation">{orientation}</span>
        </div>
      </div>
    </div>
  );
}
export function CardThumbnail({ cardId }: { cardId: string }) {
  const { suit, art } = cardArt(cardId);
  return <Art name={art} className={`source-art suit-${suit}`} />;
}
