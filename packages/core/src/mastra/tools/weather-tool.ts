import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

export const weatherTool = createTool({
  id: 'get-weather',
  description:
    'Get the current weather for a city: temperature, humidity, wind, and conditions.',
  inputSchema: z.object({
    location: z.string().describe('City name, e.g. "Istanbul"'),
  }),
  outputSchema: z.object({
    location: z.string(),
    temperatureC: z.number(),
    humidity: z.number(),
    windKph: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ location }) => {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
    ).then((r) => r.json())

    const place = geo?.results?.[0]
    if (!place) throw new Error(`Could not find location "${location}"`)

    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`,
    ).then((r) => r.json())

    const cur = wx.current
    return {
      location: [place.name, place.country].filter(Boolean).join(', '),
      temperatureC: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      windKph: cur.wind_speed_10m,
      conditions: weatherCodeToText(cur.weather_code),
    }
  },
})

function weatherCodeToText(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    80: 'Rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail',
  }
  return map[code] ?? 'Unknown'
}
