import axios from 'axios';

const JUPITER_API_URL = 'https://api.jupiter.com/v1';

export const fetchMarketData = async (pair: string) => {
    try {
        const response = await axios.get(`${JUPITER_API_URL}/market/${pair}`);
        return response.data;
    } catch (error) {
        throw new Error(`Error fetching market data: ${error.message}`);
    }
};

export const executeTrade = async (tradeDetails: { pair: string; amount: number; price: number }) => {
    try {
        const response = await axios.post(`${JUPITER_API_URL}/trade`, tradeDetails);
        return response.data;
    } catch (error) {
        throw new Error(`Error executing trade: ${error.message}`);
    }
};