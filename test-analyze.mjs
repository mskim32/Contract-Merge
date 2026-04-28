import fetch from 'node-fetch';

async function test() {
  const payload = {
    files: [{
      name: "test.docx",
      // Fake base64 of a docx. Wait, we can't do this easily.
      // Since mammoth throws if it's not a real zip, we need a real base64.
      // Let's just create a tiny text file base64? No, mammoth expects docx.
      base64: "UEsDBAoAAAAAAGy5iFEAAAAAAAAAAAAAAAAIABAAZG9jUHJvcHMvVVgMAM2VbmXOlm5ldXgLAAEE6AMAAAToAwAAUEsDBAoAAAAAAGy5iFEAAAAAAAAAAAAAAAAJABAAZG9jUHJvcHMvY29yZS54bWxVWAwAzZVuZc6WbmV1eAsAAQToAwAABOgDAABQSwMEFAAAAAgAbLmIUaXQzjTqAAAACgEAAAsAEABfcmVscy8ucmVsc1VYDADNlW5lzpZuZXV4CwABBOgDAAAE6AMAAH2QQQrCQAxG74L3EGa304KIyEy7EJdupQcwaZMG2pSQtOLtDdiNgiB4e+//5P30b2/L6DlxomDtrYJSUkAxOMvB2UfF0/kIigWjsXHGXkE1gP30tG905O4sL0dJmRElKxgl01GzXyUTzWIVXqM8Y8i1q5o8eL1XULWqP4Ssn/Wga/yq6Qf67D6FvH0aIe+fV2x0a62wD2M/L2NfP2f+92E/wQswD1BLAwQUAAAACABsuYhRo0N3+xABAACuAwAAEQAQAHdvcmQvZG9jdW1lbnQueG1sVVgMAM2VbmXOlm5ldXgLAAEE6AMAAAToAwAAjZPBitswEIbvBd9B0LvG1m5S2mRTYrfE5NAeStjTHoVkbFtsS0OStsnT9O1rO6HdBkrPkiH/N/R9M+1uc2G9p9BItJ7xcsh4AvKUVrJumV/m1/GMJ8EJ1oTW1sx7yOzu8vVru0Z2qPDo0YI5p9Z4ZnZc1+S1aBv0B902aEGzstEWaEHflXWNVtAt2m2DF1Jp4Vojq7D6I6rUeW49PItEaQW91l46EIfvE3vjX0r+jW9S/K/9z95/0Qx//0P4Hw1f9Z+E/9HwfX1G+D8NX/afhf/R8F3/TfgfDd/3R4T/0fBl/1n4Hw1f9Z+E/9Hwff9Z+B8NX/WfhP/R8H1/Tfg3Dcsb7o4Z/zUMk//tYv+y4f4f4V82PPxj/Mvh/1D82/D/Wf+y4f4f4V82PPxT/BvwHx8AUEsBAhQAFAAAAAgAbLmIUaNDd/sQAQAArgMAABEAEAAAAAAAAAAAAAAAgAEAeAACAAB3b3JkL2RvY3VtZW50LnhtbFVYCADNlW5ldXgLAAEE6AMAAAToAwAAUEsFBgAAAAACAAMAnwAAAPABAAAAAA=="
    }]
  };

  const response = await fetch("http://127.0.0.1:3001/api/analyze-docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  console.log("Status:", response.status);
  console.log("Response Body:", text);
}
test();
