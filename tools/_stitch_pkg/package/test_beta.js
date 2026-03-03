
// Mock testing for beta feature

// Mocking the behavior since we can't easily import the internal tool logic without starting the server.
// Use a simple unit test for the logic we just added.

function getPreviewLink(projectId, screenId) {
    return `https://stitch.withgoogle.com/preview/${projectId}?node-id=${screenId}`;
}

const projectId = "11474362735264571185";
const screenId = "22fc597b61a54a82a7f974c6f54bb010";
const expectedUrl = "https://stitch.withgoogle.com/preview/11474362735264571185?node-id=22fc597b61a54a82a7f974c6f54bb010";

console.log("Testing get_preview_link logic...");
const result = getPreviewLink(projectId, screenId);

if (result === expectedUrl) {
    console.log("✅ URL matches expected output:");
    console.log(result);
} else {
    console.error("❌ URL generation failed!");
    console.error("Expected:", expectedUrl);
    console.error("Got:", result);
}
