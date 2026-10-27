import { Icon } from './icon.tsx';

export type NoticeMessage = {
  text: string;
  tone: 'error' | 'success' | 'notice';
};

export function Notice({ message }: { message: NoticeMessage | null }) {
  if (!message) return null;
  const error = message.tone === 'error';
  return (
    <p role={error ? 'alert' : 'status'} className={`notice ${message.tone}`}>
      <Icon name={error ? 'warning' : message.tone === 'success' ? 'check' : 'info'} />
      <span>{message.text}</span>
    </p>
  );
}
