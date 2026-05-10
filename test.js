import http from 'k6/http';
import { sleep } from 'k6';

export let options = {
  vus: 100,        // virtual users
  duration: '30s',
};

export default function () {
  http.post('http://localhost:3000/api/v1/bookings', {});
  sleep(0.1);
}
