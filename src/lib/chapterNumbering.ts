// The single boundary between the UI's 1-based chapter numbers and the database's
// 0-based order_index / chapter_order (Amendment A2.1). The database stays 0-based
// everywhere (a character_states row applies to chapters with
// order_index >= chapter_order); the UI speaks 1-based chapter numbers EVERYWHERE.
// Every conversion between the two scales must go through these two helpers so the
// convention lives in exactly one place.

// The 1-based chapter number the UI shows for a stored 0-based order.
export function orderToUiChapter(order: number): number {
  return order + 1;
}

// The 0-based order to store for a 1-based chapter number entered in the UI.
export function uiChapterToOrder(uiChapter: number): number {
  return uiChapter - 1;
}
