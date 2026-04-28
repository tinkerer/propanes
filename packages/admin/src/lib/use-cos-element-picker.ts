import { useEffect, useRef, useState, type RefObject } from 'preact/hooks';
import { startPicker, type SelectedElementInfo } from '@propanes/widget/element-picker';
import type { CosElementRef } from './chief-of-staff.js';
import { isMobile } from './viewport.js';

/**
 * Element-picker state + lifecycle for the CoS bubble.
 *
 * Owns:
 *   - pickerActive (button highlight + escape route)
 *   - pickerMultiSelect / pickerIncludeChildren (persisted under
 *     `pw-cos-pick-multi` / `pw-cos-pick-children`)
 *   - the cleanup ref returned by startPicker()
 *   - startElementPick / stopElementPicker — wraps the widget's picker
 *
 * Load-bearing: on mobile the CoS panel fills the viewport, so the picker
 * has to hide it during selection (otherwise the operator can't tap anything
 * else). prevDisplay is captured per-pick so closing restores the panel's
 * exact prior display rule even if the host inlined one.
 *
 * The hook receives the wrapperRef (the panel root) and a callback that
 * appends the captured CosElementRef[] onto the parent's pending attachments.
 */
export function useCosElementPicker(opts: {
  wrapperRef: RefObject<HTMLDivElement>;
  appendElementRefs: (refs: CosElementRef[]) => void;
  focusInput: () => void;
  closePickerMenu: () => void;
}) {
  const [pickerActive, setPickerActive] = useState(false);
  const [pickerMultiSelect, setPickerMultiSelect] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-multi') : null;
    return v === '1';
  });
  const [pickerIncludeChildren, setPickerIncludeChildren] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-children') : null;
    return v === '1';
  });
  const pickerCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => { try { localStorage.setItem('pw-cos-pick-multi', pickerMultiSelect ? '1' : '0'); } catch { /* ignore */ } }, [pickerMultiSelect]);
  useEffect(() => { try { localStorage.setItem('pw-cos-pick-children', pickerIncludeChildren ? '1' : '0'); } catch { /* ignore */ } }, [pickerIncludeChildren]);

  function stopElementPicker() {
    if (pickerCleanupRef.current) {
      pickerCleanupRef.current();
      pickerCleanupRef.current = null;
    }
    setPickerActive(false);
  }

  function startElementPick() {
    if (pickerActive) {
      stopElementPicker();
      return;
    }
    const host = opts.wrapperRef.current;
    if (!host) return;
    setPickerActive(true);
    opts.closePickerMenu();
    // On mobile the CoS panel fills the viewport, so it must be hidden to allow
    // picking anything else. On desktop the panel stays put and is selectable
    // like any other element — drag/minimize it if it's covering your target.
    const mobile = isMobile.value;
    const prevDisplay = host.style.display;
    if (mobile) host.style.display = 'none';
    const restoreHost = () => {
      if (mobile) host.style.display = prevDisplay;
    };
    const cleanup = startPicker(
      (infos: SelectedElementInfo[]) => {
        restoreHost();
        pickerCleanupRef.current = null;
        setPickerActive(false);
        if (infos.length === 0) return;
        const mapped: CosElementRef[] = infos.map((i) => ({
          selector: i.selector,
          tagName: i.tagName,
          id: i.id || undefined,
          classes: i.classes,
          textContent: i.textContent,
          boundingRect: i.boundingRect,
          attributes: i.attributes,
        }));
        opts.appendElementRefs(mapped);
        opts.focusInput();
      },
      host,
      { multiSelect: pickerMultiSelect, excludeWidget: false, includeChildren: pickerIncludeChildren },
    );
    pickerCleanupRef.current = cleanup;
  }

  // Cleanup on unmount: kill any in-flight picker so its overlay doesn't
  // leak after the bubble closes.
  useEffect(() => {
    return () => {
      if (pickerCleanupRef.current) {
        pickerCleanupRef.current();
        pickerCleanupRef.current = null;
      }
    };
  }, []);

  return {
    pickerActive,
    pickerMultiSelect,
    setPickerMultiSelect,
    pickerIncludeChildren,
    setPickerIncludeChildren,
    startElementPick,
  };
}
