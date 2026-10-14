// Keep each reader response small enough for mobile Safari/WebViews and reverse proxies.
// The old 10,000-paragraph response could be several megabytes for a full novel.
export const BOOK_SLICE_SIZE = 1000;
export const LARGE_BOOK_THRESHOLD = 3000;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function loadBookSlices({
    totalParas,
    fetchSlice,
    onProgress = () => {},
    chunkSize = BOOK_SLICE_SIZE,
    maxAttempts = 3,
}) {
    const total = Math.max(0, Number(totalParas) || 0);
    const paragraphs = [];
    const comments = [];
    const seenCommentIds = new Set();

    for (let start = 0; start < total; start += chunkSize) {
        let data;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                data = await fetchSlice(start, chunkSize);
                break;
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) await wait(200 * attempt);
            }
        }
        if (!data) throw lastError || new Error('书籍分段加载失败');

        const batch = Array.isArray(data.paragraphs) ? data.paragraphs : [];
        paragraphs.push(...batch);
        for (const comment of Array.isArray(data.comments) ? data.comments : []) {
            if (!seenCommentIds.has(comment.id)) {
                seenCommentIds.add(comment.id);
                comments.push(comment);
            }
        }
        onProgress(Math.min(1, (start + batch.length) / Math.max(1, total)));
        if (batch.length < chunkSize) break;
    }

    return { paragraphs, comments };
}
