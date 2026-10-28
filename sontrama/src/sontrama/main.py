import os
import sys

import uvicorn


def main():
    # Keep UI requests from holding the GIL across an audio deadline.
    sys.setswitchinterval(0.001)
    uvicorn.run(
        "sontrama.app:create_app",
        factory=True,
        host=os.getenv("SONTRAMA_HOST", "127.0.0.1"),
        port=int(os.getenv("SONTRAMA_PORT", "8081")),
        ssl_certfile=os.getenv("SONTRAMA_TLS_CERT"),
        ssl_keyfile=os.getenv("SONTRAMA_TLS_KEY"),
    )


if __name__ == "__main__":
    main()
