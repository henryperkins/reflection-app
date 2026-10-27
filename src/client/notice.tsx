export type NoticeMessage = {
  text: string;
  tone: 'error' | 'success' | 'notice';
};

export function Notice({ message }: { message: NoticeMessage | null }) {
  if (!message) return null;
  const error = message.tone === 'error';
  return (
    <p role={error ? 'alert' : 'status'} className={error ? 'notice error' : 'notice'}>
      {message.text}
    </p>
  );
}
