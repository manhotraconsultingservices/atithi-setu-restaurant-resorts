import { useEffect, useRef, useState } from 'react';

export function useSocket(role: string, restaurantId: string) {
  const [lastMessage, setLastMessage] = useState<any>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'AUTH', role, restaurantId }));
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLastMessage(data);
    };

    socketRef.current = socket;

    return () => {
      socket.close();
    };
  }, [role, restaurantId]);

  return { lastMessage };
}
