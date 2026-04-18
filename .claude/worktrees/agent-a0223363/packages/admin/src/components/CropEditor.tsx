import { useRef, useEffect } from 'preact/hooks';
import { ImageEditor } from '@prompt-widget/widget/image-editor';
import { api } from '../lib/api.js';

interface Props {
  src: string;
  imageId: string;
  feedbackId: string;
  onClose: () => void;
  onSaved: (mode: 'replace' | 'new', newScreenshot?: { id: string; filename: string }) => void;
}

export function CropEditor({ src, imageId, feedbackId, onClose, onSaved }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ImageEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const editor = new ImageEditor({
      container: containerRef.current,
      image: src,
      tools: ['highlight', 'crop'],
      initialTool: 'crop',
      saveActions: [
        {
          label: 'Apply (Overwrite)',
          primary: true,
          handler: async (blob) => {
            await api.replaceImage(imageId, blob);
            onSaved('replace');
          },
        },
        {
          label: 'Save as New',
          handler: async (blob) => {
            const result = await api.saveImageAsNew(feedbackId, blob);
            onSaved('new', { id: result.id, filename: result.filename });
          },
        },
      ],
      onCancel: onClose,
    });
    editorRef.current = editor;

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, [src, imageId, feedbackId]);

  return <div ref={containerRef} style="display:flex;flex-direction:column;align-items:center;width:100%" />;
}
