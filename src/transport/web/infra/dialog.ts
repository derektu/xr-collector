export function showModalOnMount(dialog: HTMLDialogElement | null): void {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
}
