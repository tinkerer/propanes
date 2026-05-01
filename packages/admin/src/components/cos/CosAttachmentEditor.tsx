import { useEffect, useRef } from 'preact/hooks';
import { ImageEditor } from '@propanes/widget/image-editor';

export function AttachmentEditorModal({
  dataUrl,
  onSave,
  onClose,
}: {
  dataUrl: string;
  onSave: (newDataUrl: string) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = new ImageEditor({
      container: containerRef.current,
      image: dataUrl,
      tools: ['highlight', 'crop'],
      initialTool: 'highlight',
      saveActions: [
        {
          label: 'Apply',
          primary: true,
          handler: (blob: Blob) => {
            const reader = new FileReader();
            reader.onload = () => onSave(reader.result as string);
            reader.readAsDataURL(blob);
          },
        },
      ],
      onCancel: onClose,
    });
    return () => editor.destroy();
  }, [dataUrl]);

  return (
    <div
      style="position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style="background:var(--cos-bg,#1a1a2e);border-radius:8px;padding:12px;max-width:90vw;max-height:90vh;overflow:auto;min-width:400px">
        <div ref={containerRef} style="display:flex;flex-direction:column;align-items:center;width:100%" />
      </div>
    </div>
  );
}
